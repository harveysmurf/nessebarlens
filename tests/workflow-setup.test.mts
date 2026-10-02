/**
 * Issue #120: every workflow reached checkout / setup-node / npm ci through
 * its own copy of the same three steps, so a pin or flag change had to be
 * applied by hand in four files. The shared composite action is the single
 * setup path; this guard fails if a workflow grows an inline copy again, or
 * if production stops calling the full CI suite before deploy.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");
const setupAction = "./.github/actions/setup";

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowDir, name), "utf8"),
  }));

test("no workflow inlines setup-node or bare npm ci, and checks out exactly once per job", () => {
  // Checkout is the one step the shared action cannot absorb: a local action is
  // read from the working tree, so it has to be on disk before it can run.
  // Pinning it to exactly one per job, immediately before the setup call,
  // keeps that exception from widening back into a duplicated setup block.
  const checkoutStep = /^\s*-\s*(?:name:\s*Checkout\s*\n\s*)?uses:\s*actions\/checkout@/gm;
  for (const { name, text } of workflows) {
    assert.doesNotMatch(
      text,
      /uses:\s*actions\/setup-node@/,
      `${name} inlines actions/setup-node; use ${setupAction}`,
    );
    assert.doesNotMatch(
      text,
      /^\s*run:\s*npm ci\b/m,
      `${name} runs bare npm ci; use ${setupAction} (with install-args if needed)`,
    );

    // A reusable-workflow caller job has `uses:` and no steps of its own; it
    // runs no actions in this repo, so it has no checkout to pin.
    const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
    for (const block of jobsText.split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1)) {
      if (/^\s*uses:\s*\.\/\.github\/workflows\//m.test(block)) continue;
      const count = [...block.matchAll(checkoutStep)].length;
      assert.equal(
        count,
        1,
        `${name} has a job with ${count} checkout steps; exactly one is expected (the composite action cannot do the checkout that loads it)`,
      );
      assert.ok(
        block.includes(setupAction),
        `${name} has a job that checks out but never calls ${setupAction}`,
      );
      const [firstCheckout] = [...block.matchAll(checkoutStep)];
      const setupIdx = block.indexOf(setupAction);
      assert.ok(
        (firstCheckout?.index ?? -1) < setupIdx,
        `${name} calls ${setupAction} before its checkout, so the action is not on disk yet`,
      );
    }
  }
  assert.ok(workflows.length > 0, "no workflows found -- the glob went stale");
});

test("every workflow uses the shared setup composite action", () => {
  for (const { name, text } of workflows) {
    assert.match(
      text,
      /uses:\s*\.\/\.github\/actions\/setup\b/,
      `${name} never calls ${setupAction}`,
    );
  }
});

test("ci.yml has no push trigger -- prod.yml calls it and gates deploy on it", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  assert.ok(ci, "ci.yml is gone");

  // Slice past the `on:` line itself, then stop at the next top-level key:
  // splitting from the `on:` line would split on it and yield an empty block.
  const onIdx = ci.text.search(/^on:[ \t]*$/m);
  assert.ok(onIdx >= 0, "ci.yml has no top-level on: block");
  const onBlock = ci.text.slice(onIdx).split(/\n\S/)[0];
  assert.doesNotMatch(
    onBlock,
    /^\s{2}push:/m,
    "ci.yml triggers on push, so every main merge runs the suite twice: once from this trigger and once from prod.yml's checks job",
  );
});

test("prod.yml deploy needs a job that calls ci.yml", () => {
  const prod = workflows.find((w) => w.name === "prod.yml");
  assert.ok(prod, "prod.yml is gone");

  const jobsIdx = prod.text.search(/^jobs:\s*$/m);
  assert.ok(jobsIdx >= 0, "prod.yml has no jobs: section");
  const jobsText = prod.text.slice(jobsIdx);

  const jobBlocks = [
    ...jobsText.matchAll(/^ {2}([a-z][\w-]*):\n((?:(?: {4}|\t).*\n|\n)*)/gm),
  ];
  assert.ok(jobBlocks.length > 0, "prod.yml has no jobs under jobs:");

  const callers = jobBlocks
    .filter(([, , body]) => /uses:\s*\.\/\.github\/workflows\/ci\.yml\b/.test(body))
    .map(([, id]) => id);
  assert.ok(
    callers.length > 0,
    "prod.yml has no job that uses ./.github/workflows/ci.yml",
  );

  const deploy = jobBlocks.find(([, id]) => id === "deploy");
  assert.ok(deploy, "prod.yml has no deploy job");
  const needsMatch = deploy[2].match(/^\s*needs:\s*(.+)$/m);
  assert.ok(needsMatch, "prod.yml deploy job has no needs:");
  const needed = needsMatch[1].trim();
  const neededIds = needed.startsWith("[")
    ? needed
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
    : [needed];
  assert.ok(
    callers.some((id) => neededIds.includes(id)),
    `prod.yml deploy needs ${JSON.stringify(neededIds)}, but the ci.yml caller(s) are ${JSON.stringify(callers)}`,
  );
});

/* #143: the browser smoke flow's CI job.

   Three things about it are decisions rather than defaults, so they are pinned
   here instead of left to the next person editing the YAML:

   - it is a job of its own, not a step in lint-and-test, because it downloads
     a browser and starts a server;
   - it does not run in `preview.yml`, because a smoke flow coupled to a deploy
     has two possible causes for every red run;
   - it is pull_request-only, because prod.yml calls ci.yml as a reusable
     workflow and a browser flow before every production merge buys nothing. */

test("the E2E flow is its own job in ci.yml, not a step in lint-and-test", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  assert.ok(ci, "ci.yml is gone");

  const job = ci.text.match(
    /^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m,
  );
  assert.ok(job, "ci.yml has no e2e-smoke job");
  const body = job[1];

  // A browser download and a dev server inside the lint job would make a lint
  // failure indistinguishable from a Chromium download failure.
  assert.doesNotMatch(
    ci.text.slice(0, ci.text.indexOf("  e2e-smoke:")),
    /playwright/,
    "the lint-and-test job must stay free of Playwright",
  );
  assert.match(body, /playwright install/, "e2e-smoke must install its browser");
  assert.match(body, /run:\s*npm run test:e2e/);
});

test("the E2E job is pull_request-only, so a production merge does not re-run a browser", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  const job = ci.text.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  // prod.yml gates deploy on the ci.yml caller job; without this guard every
  // production merge pays for a Chromium download to re-test the same commit.
  assert.match(
    job[1],
    /if:\s*github\.event_name\s*==\s*'pull_request'/,
    "e2e-smoke must not run when ci.yml is called by prod.yml",
  );
});

test("no workflow other than ci.yml runs Playwright", () => {
  for (const { name, text } of workflows) {
    if (name === "ci.yml") continue;
    assert.doesNotMatch(
      text,
      /playwright|npm run test:e2e/,
      `${name} runs the browser flow; it belongs in ci.yml (Architect, #143)`,
    );
  }
});

test("the E2E job refuses to run without a Stripe TEST key", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  const job = ci.text.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  const body = job[1];

  // The specs skip themselves with no key, so without this the job would go
  // green having tested only the seeded success-page states.
  assert.match(body, /STRIPE_SECRET_KEY/, "must read a Stripe key");
  // The key comes from the staging Environment, whose single STRIPE_SECRET_KEY
  // is the sandbox one. Two things have to hold together here, and the second
  // is what makes the first safe:
  //  - `environment: staging`, or `secrets.*` resolves against the repository
  //    scope and resolves to nothing at all.
  //  - the sk_test_ guard below, which is what actually stops a live key from
  //    being spent. Dropping the environment line breaks the job; dropping the
  //    guard would let a live key through, so the guard is asserted, not
  //    trusted.
  assert.match(body, /^ {4}environment: staging$/m, "the staging keys are Environment secrets");
  assert.match(body, /sk_test_\*/, "must reject a non-test key before paying");
});

test("the E2E job refuses to run without a Prodigi sandbox key", () => {
  // The same partial-green trap as the Stripe guard, one spec down: the
  // physical-print spec test.skips() without this key, so a job missing the
  // secret would pass having never quoted Prodigi at all (#143 review).
  const ci = workflows.find((w) => w.name === "ci.yml");
  const job = ci.text.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  const body = job[1];

  assert.match(body, /secrets\.PRODIGI_SANDBOX_API_KEY/, "must read the sandbox key");
});

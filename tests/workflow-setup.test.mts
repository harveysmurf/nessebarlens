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

/**
 * Workflows that never run code from this repository, so there is nothing for
 * the shared action to set up. An entry here is a claim that the workflow runs
 * no `npm`/`node`/build step and reads no repo file except through the ones the
 * guard already checks; a workflow that grows a `run:` step needing Node has to
 * come off this list and call the action instead. Kept as an explicit list, not
 * a heuristic, so the exemption is a reviewable decision rather than something
 * a new file can acquire by accident.
 */
const noRepoCode: readonly string[] = ["reconcile.yml"];

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
    if (noRepoCode.includes(name)) continue;
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
    if (noRepoCode.includes(name)) continue;
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

/* #143: the browser smoke flow's CI jobs.

   Five things about them are decisions rather than defaults, so they are pinned
   here instead of left to the next person editing the YAML:

   - they are jobs of their own, not steps in lint-and-test, because they
     download a browser and start a server;
   - they do not run in `preview.yml`, because a smoke flow coupled to a deploy
     has two possible causes for every red run;
   - they are pull_request-only, because prod.yml calls ci.yml as a reusable
     workflow and a browser flow before every production merge buys nothing;
   - the seeded specs are the gate and the hosted-checkout specs are
     best-effort, because Stripe gates its own page behind a bot check and an
     "I am an AI agent" attestation (Architect, #160 review);
   - the hosted job keeps the key guards and the headed run, because it is the
     only one that can use them. The required job runs no third party and needs
     no secret. */

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
  assert.match(body, /npm run test:e2e/, "e2e-smoke must run the suite");
  assert.doesNotMatch(
    body,
    /xvfb-run|HEADED/,
    "the required job runs only seeded specs, so it needs no display and no key",
  );

  // The hosted job, and only it, drives a real Stripe sandbox checkout page.
  const hosted = ci.text.match(
    /^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m,
  );
  assert.ok(hosted, "ci.yml has no e2e-hosted-checkout job");
  // The xvfb-run wrapper is not incidental: Stripe gates the hosted-checkout
  // submit on a bot check that headless Chromium on a runner never satisfies.
  // The assertion is on the command underneath the wrapper, and HEADED=1 is
  // what tells playwright.config.ts to open a real window. It is not expected
  // to be sufficient — a later run added an attestation dialog in front of the
  // same submit — which is why this job is soft-failed rather than required.
  assert.match(hosted[1], /npm run test:e2e/);
  assert.match(hosted[1], /xvfb-run/, "the hosted browser must run headed");
  assert.match(hosted[1], /HEADED: "1"/, "HEADED=1 must reach the Playwright config");
});

test("the E2E job is pull_request-only, so a production merge does not re-run a browser", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  for (const id of ["e2e-smoke", "e2e-hosted-checkout"]) {
    const job = ci.text.match(
      new RegExp(`^ {2}${id}:\\n((?:(?: {4}|\\t).*\\n|\\n)*)`, "m"),
    );
    assert.ok(job, `ci.yml has no ${id} job`);
    // prod.yml gates deploy on the ci.yml caller job; without this guard every
    // production merge pays for a Chromium download to re-test the same commit.
    assert.match(
      job[1],
      /if:\s*github\.event_name\s*==\s*'pull_request'/,
      `${id} must not run when ci.yml is called by prod.yml`,
    );
  }
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

test("the hosted E2E job refuses to run without a Stripe TEST key", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  const job = ci.text.match(/^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m);
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

test("the hosted E2E job refuses to run without a Prodigi sandbox key", () => {
  // The same partial-green trap as the Stripe guard, one spec down: the
  // physical-print spec test.skips() without this key, so a job missing the
  // secret would pass having never quoted Prodigi at all (#143 review).
  const ci = workflows.find((w) => w.name === "ci.yml");
  const job = ci.text.match(/^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  const body = job[1];

  assert.match(body, /secrets\.PRODIGI_SANDBOX_API_KEY/, "must read the sandbox key");
});

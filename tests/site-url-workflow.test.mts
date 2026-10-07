/**
 * next.config.ts refuses a production build without NEXT_PUBLIC_SITE_URL,
 * which is only useful if every workflow that builds actually supplies it. A
 * deploy workflow that dropped the env would not fail quietly -- it would fail
 * as a red build that reads like an unrelated OpenNext problem, or, worse,
 * someone "fixes" the red build by weakening the guard. Same shape as
 * node-version-pin.test.mts: a value duplicated across workflows is only safe
 * while a test holds the copies to the same value.
 *
 * This is a workflow assertion, not a siteUrl() one: tests/site-url.test.mts
 * covers what the helper does, this covers that nothing can ship without it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowDir, name), "utf8"),
  }));

/**
 * Workflows that build a deployable artifact, so they need the env.
 * `release.yml` replaced `prod.yml`/`staging.yml` in #200: one pipeline, and the
 * build is a per-environment matrix rather than a copy in each deploy workflow.
 * The matrix reads the secret once at job level, which is why the assertion
 * below is satisfied by a single occurrence.
 */
const BUILDING = ["preview.yml", "release.yml"];

test("every workflow that builds gets NEXT_PUBLIC_SITE_URL from secrets", () => {
  for (const name of BUILDING) {
    const workflow = workflows.find((w) => w.name === name);
    assert.ok(workflow, `${name} is gone; update BUILDING if the build moved`);
    // Job-level `env:` or a step-level one, either is enough -- what must not
    // happen is a literal or a plain var standing in for the secret.
    assert.match(
      workflow.text,
      /NEXT_PUBLIC_SITE_URL:\s*\$\{\{\s*secrets\.NEXT_PUBLIC_SITE_URL\s*\}\}/,
      `${name} builds without secrets.NEXT_PUBLIC_SITE_URL, so the production-build guard in next.config.ts fires and takes the deploy down`,
    );
  }
});

test("every workflow that builds gets the derivative-ladder env from secrets", () => {
  // The gallery is statically generated, so the ladder base and its on/off flag
  // are baked at build time. A build that dropped the flag would render every
  // tile from the committed placeholder, which is the state a reviewer of a PR
  // preview is meant to check before `publish-photos --promote` (#257).
  for (const name of BUILDING) {
    const workflow = workflows.find((w) => w.name === name);
    assert.ok(workflow, `${name} is gone; update BUILDING if the build moved`);
    for (const env of [
      "NEXT_PUBLIC_WEB_IMAGES_BASE",
      "NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED",
    ]) {
      assert.match(
        workflow.text,
        new RegExp(`${env}:\\s*\\$\\{\\{\\s*secrets\\.${env}\\s*\\}\\}`),
        `${name} builds without secrets.${env}`,
      );
    }
  }
});

test("no workflow inlines a site url literal that could drift from the secret", () => {
  for (const { name, text } of workflows) {
    // ci.yml and verify-stripe.yml legitimately have no site url; only a
    // hardcoded origin in a deploy workflow is the drift risk.
    if (!BUILDING.includes(name)) continue;
    const literals = [
      // The lookahead sits directly after the colon: with a `\s*` in front of
      // it the engine backtracks the spaces and the guard passes on the
      // secret form, which is the one case we are looking for.
      ...text.matchAll(/NEXT_PUBLIC_SITE_URL:(?!\s*\$\{\{)\s*([^\n]+)/g),
    ].map((m) => m[1].trim());
    assert.deepEqual(
      literals,
      [],
      `${name} sets NEXT_PUBLIC_SITE_URL to a literal instead of the secret`,
    );
  }
});

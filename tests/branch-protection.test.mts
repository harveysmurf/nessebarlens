/**
 * #205 item 1: branch protection required only `Lint & test`, so `Workflow
 * audit` and `E2E smoke flow` could be red on a pull request and the merge
 * button was still enabled — the gap behind #120.
 *
 * Fixing the setting is a single API call and then it is invisible to review,
 * which is the same class of problem as an unpinned action: real work with
 * nothing holding it in place. The rule that holds it here is that the required
 * list is a committed file, and it must agree with ci.yml in both directions:
 *
 *   - a gating job added to ci.yml and not added to the list fails here
 *   - a list entry that matches no job name fails here (rename or typo)
 *   - a `continue-on-error` job listed as required fails here, because a check
 *     the workflow ignores cannot gate anything
 *
 * The comparison against the live GitHub setting is scripts/required-checks.mjs,
 * run BY HAND with an admin-scoped token rather than from ci.yml: reading branch
 * protection needs the `administration` permission, which a job's GITHUB_TOKEN
 * cannot be granted, so no workflow step can perform that comparison at all.
 * This file is therefore the half that runs on every test run, and it is what
 * keeps a gate added to ci.yml from being mergeable-but-ungated.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ciJobs, readRequiredContexts, remediationCommand } from "../scripts/required-checks.mjs";

const jobs = ciJobs();
const required = readRequiredContexts();
const byName = new Map(jobs.map((job) => [job.name, job]));

test("every gating CI job is a required status check", () => {
  const missing = jobs.filter((job) => !job.soft && !required.includes(job.name));
  assert.deepEqual(
    missing.map((job) => job.name),
    [],
    `these jobs can fail a pull request without blocking the merge; add each to .github/required-checks.txt: ${missing.map((job) => job.id).join(", ")}`,
  );
});

test("every required status check names a job that exists in ci.yml", () => {
  // A renamed job leaves its old name in protection, which GitHub accepts
  // forever while the new name runs ungated — the exact hole this file closes,
  // reached the other way round.
  const unknown = required.filter((name) => !byName.has(name));
  assert.deepEqual(unknown, [], `required but no ci.yml job reports this name: ${unknown.join(", ")}`);
});

test("no continue-on-error job is required", () => {
  const soft = required.filter((name) => byName.get(name)?.soft);
  assert.deepEqual(
    soft,
    [],
    `these jobs are continue-on-error, so requiring them blocks merges on a result the workflow discards: ${soft.join(", ")}`,
  );
});

test("the E2E smoke flow is the gate, and the hosted checkout is not", () => {
  // Named individually because the two jobs are the pair #205 turned on and
  // deliberately left off: the smoke flow is seeded and deterministic, the
  // hosted checkout depends on Stripe's own bot gate (#169).
  assert.ok(required.includes("E2E smoke flow"), "the seeded smoke flow must block merges");
  assert.ok(!required.includes("E2E hosted checkout (best effort)"), "the hosted checkout stays best-effort");
});

test("the required list has no duplicates", () => {
  // A duplicate is harmless to GitHub and hides a list that has drifted into
  // two halves; treat it as the sign that the file is being edited carelessly.
  assert.deepEqual(
    required.filter((name, index) => required.indexOf(name) !== index),
    [],
  );
});

test("ci.yml does not try to verify branch protection", () => {
  // #205 item 1 ran `required-checks.mjs` as a ci.yml step. It could not work:
  // reading branch protection needs the `administration` permission, which a
  // job's GITHUB_TOKEN cannot be granted, so the step failed with exit 4 "no
  // GITHUB_TOKEN/GH_TOKEN" on every run and reported nothing about the drift it
  // existed to catch. The live comparison is a manual tool instead (see
  // DEVELOPMENT.md §Required status checks), and this asserts the step stays
  // gone -- putting it back would produce a check that is always red and never
  // informative, which is worse than no check at all.
  const ci = fs.readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/required-checks\.mjs/.test(ci),
    "ci.yml invokes required-checks.mjs again; a workflow step cannot read branch protection, so this can only ever exit 4",
  );
});

test("the drift hint PATCHes /required_status_checks, never the bare protection endpoint", () => {
  // branches/main/protection accepts PUT only, so `-X PATCH` there is a 404
  // whatever the token can do. The old hint printed exactly that.
  const hint = remediationCommand("owner/repo", required);
  assert.match(
    hint,
    /gh api -X PATCH repos\/owner\/repo\/branches\/main\/protection\/required_status_checks --input -/,
  );
  assert.ok(
    !/-X PATCH \S*branches\/main\/protection(?!\/required_status_checks)/.test(hint),
    "the hint PATCHes branches/main/protection, which has no PATCH and returns 404",
  );
  const body = JSON.parse(/<<'JSON'\n([\s\S]*)\nJSON$/.exec(hint)?.[1] ?? "null");
  assert.deepEqual(body, {
    strict: true,
    checks: required.map((context) => ({ context, app_id: 15368 })),
  });
});

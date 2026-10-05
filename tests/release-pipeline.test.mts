/**
 * #200: `staging.yml` and `prod.yml` both triggered on the same push to main
 * and ran in parallel, so staging rehearsed nothing — a build that broke
 * staging's smoke still shipped to production, and a failed D1 migration only
 * ever reached staging. `release.yml` replaces the pair with one ordered
 * pipeline, and the ordering is the deliverable. Every assertion here is about
 * a step that can be silently dropped by an edit that looks harmless.
 *
 * Two things this file deliberately does NOT pin, because they were argued and
 * decided rather than derived:
 *
 *   - `e2e-smoke` staying pull_request-only (tests/workflow-setup.test.mts).
 *     With strict branch protection the tree on main already passed that flow on
 *     its PR; re-running the identical tree is how #206's flaky coverage held
 *     production for 1.5h. The actual #120 gap is that E2E smoke flow is not a
 *     *required* check, which is #205 item 1.
 *   - two builds rather than one shared artifact. Both are defensible; the
 *     origin is baked into prerendered HTML (`src/app/layout.tsx` builds
 *     metadataBase at module scope), so one artifact would put nessebarlens.com
 *     on staging. Pinned below as "the build is a matrix", not as a comment.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");

const release = fs.existsSync(path.join(workflowDir, "release.yml"))
  ? fs.readFileSync(path.join(workflowDir, "release.yml"), "utf8")
  : null;

/** Job bodies keyed by job id, split on a two-space job key. */
function jobs(text: string): Record<string, string> {
  const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
  const out: Record<string, string> = {};
  for (const [, id, body] of jobsText.matchAll(
    /^ {2}([a-z][\w-]*):\n((?:(?: {4}|\t).*\n|\n)*)/gm,
  )) {
    out[id] = body;
  }
  return out;
}

function needed(text: string, job: string): string[] {
  const match = jobs(text)[job]?.match(/^\s*needs:\s*(.+)$/m);
  assert.ok(match, `release.yml has no ${job} job, or it declares no needs:`);
  const raw = match[1].trim();
  return raw.startsWith("[")
    ? raw.slice(1, -1).split(",").map((s) => s.trim())
    : [raw];
}

/** Step index of the first step whose `- name:` contains `needle`. */
function stepIndex(body: string, needle: string): number {
  const steps = [...body.matchAll(/^ {6}- name: (.*)$/gm)];
  const index = steps.findIndex(([, name]) =>
    name.toLowerCase().includes(needle.toLowerCase()),
  );
  assert.notEqual(
    index,
    -1,
    `no step matching ${JSON.stringify(needle)}; steps are ${JSON.stringify(steps.map(([, n]) => n))}`,
  );
  return index;
}

test("the parallel staging/prod pair is gone and release.yml replaces both", () => {
  assert.ok(release, "release.yml is missing — #200's pipeline is the only deploy path");
  for (const name of ["staging.yml", "prod.yml"]) {
    assert.equal(
      fs.existsSync(path.join(workflowDir, name)),
      false,
      `${name} still exists. It triggers on the same push to main as release.yml and deploys in parallel with it, which is the bug #200 exists to remove — delete it, do not leave it as a second path`,
    );
  }
  // And nothing else kept the trigger they used to have. Read as "triggers on
  // push to main" rather than as a deploy-command grep: preview.yml deploys a
  // per-PR version with a plain `wrangler deploy`, so a command-shaped check
  // would pass it by accident while a reintroduced main-deploying workflow in
  // any other form would slip through. release.yml is the only workflow that
  // may react to a merge.
  const onPushToMain = fs
    .readdirSync(workflowDir)
    .filter((n) => n.endsWith(".yml") && n !== "release.yml")
    .filter((n) => {
      const text = fs.readFileSync(path.join(workflowDir, n), "utf8");
      const onIdx = text.search(/^on:[ \t]*$/m);
      if (onIdx < 0) return false;
      const onBlock = text.slice(onIdx).split(/\n\S/)[0];
      return /^\s{2}push:/m.test(onBlock) && /branches:\s*\[main\]/.test(onBlock);
    });
  assert.deepEqual(
    onPushToMain,
    [],
    `workflow(s) ${JSON.stringify(onPushToMain)} still trigger on push to main. release.yml owns that trigger: a second one runs beside it in parallel, which is the #200 problem`,
  );
});

test("release.yml triggers on push to main and never cancels a run part-way", () => {
  assert.match(release!, /^\s{2}push:\s*$/m);
  assert.match(release!, /^\s{4}branches: \[main\]$/m);
  // A cancelled run can stop between the D1 migration and the deploy, leaving
  // the schema ahead of the code. This is the one workflow where that is a real
  // and unrecoverable-by-retry state, which is why it is asserted.
  assert.match(release!, /^concurrency:\s*\n {2}group: release\s*\n {2}cancel-in-progress: false$/m);
});

test("production deploys only after staging has migrated and passed its smoke", () => {
  const body = jobs(release!);
  assert.ok(body.production, "release.yml has no production job");

  const needs = needed(release!, "production");
  assert.ok(
    needs.includes("staging"),
    `production needs ${JSON.stringify(needs)} — without staging it deploys in parallel with it, which is the #200 problem verbatim`,
  );
  assert.ok(
    needs.includes("checks"),
    `production needs ${JSON.stringify(needs)} — without checks it can deploy a commit whose suite never ran`,
  );
  assert.ok(
    needs.includes("build"),
    `production needs ${JSON.stringify(needs)} — the deploy reads an artifact the build job produces`,
  );
});

test("checks runs the full CI suite, not a subset of it", () => {
  const body = jobs(release!).checks ?? "";
  assert.match(
    body,
    /uses:\s*\$\/\.github\/workflows\/ci\.yml/,
    "release.yml must call the whole ci.yml reusable workflow; naming lint-and-test directly would skip the workflow audit and the browser jobs",
  );
});

test("both deploy jobs apply D1 migrations before deploying", () => {
  const body = jobs(release!);
  for (const job of ["staging", "production"]) {
    const steps = body[job];
    assert.ok(steps, `release.yml has no ${job} job`);

    const migrate = /wrangler d1 migrations apply[^\n]*--remote/.test(steps);
    assert.ok(
      migrate,
      `${job} never applies D1 migrations remotely. A PR adding a migration and code that reads it deploys code against a schema that does not have it, and the failure lands after the customer has paid`,
    );

    const migrateAt = stepIndex(steps, "migrations");
    // The deploy step specifically, not any step whose name contains "deploy":
    // "Record the currently deployed version" matches the loose form and is
    // three steps earlier, which would invert the assertion.
    const deployAt = stepIndex(steps, `Deploy ${job}`);
    assert.ok(
      migrateAt < deployAt,
      `${job} applies migrations at step ${migrateAt} and deploys at step ${deployAt}; the deploy must come second or new code runs against an older schema`,
    );
  }
});

test("production targets the production D1 and staging targets the staging one", () => {
  const body = jobs(release!);
  // The two are different databases in different Workers. A production job
  // pointed at the staging D1 migrates nothing that production reads, and the
  // symptom is a production runtime error some minutes after a green run.
  assert.match(body.staging, /nessebar-lens-orders-staging --remote --env staging/);
  assert.match(body.production, /nessebar-lens-orders --remote/);
  // `--env staging` on the production command would resolve [env.staging]'s
  // bindings, which is the same mistake one token away.
  assert.doesNotMatch(
    body.production.match(/wrangler d1 migrations apply[^\n]*/)?.[0] ?? "",
    /--env/,
    "the production migration must not pass --env; the top-level binding IS production and --env staging would migrate the wrong database",
  );
});

test("both deploy jobs smoke after deploying, and staging's smoke gates production", () => {
  const body = jobs(release!);
  for (const job of ["staging", "production"]) {
    const smokeAt = stepIndex(body[job], "Smoke");
    const deployAt = stepIndex(body[job], `Deploy ${job}`);
    assert.ok(
      smokeAt > deployAt,
      `${job} smokes at step ${smokeAt} and deploys at step ${deployAt}; a smoke before the deploy proves nothing about what was deployed`,
    );
  }
  // And the smoke has to be pointed at the right host, or it proves nothing:
  // staging's smoke against the apex domain is a passing check on code that
  // never reached staging.
  assert.match(body.staging, /smoke\.sh "\$EXPECTED_ORIGIN"/);
  assert.match(body.staging, /EXPECTED_ORIGIN: https:\/\/staging\.nessebarlens\.com/);
  assert.match(body.production, /EXPECTED_ORIGIN: https:\/\/nessebarlens\.com/);
});

test("a failed production smoke rolls back to the version recorded before the deploy", () => {
  const body = jobs(release!);
  const steps = body.production;

  // The record has to come before the deploy: afterwards the newest version is
  // the bad one and there is nothing to roll back to.
  const recordAt = stepIndex(steps, "Record the currently deployed version");
  const deployAt = stepIndex(steps, "Deploy production");
  assert.ok(
    recordAt < deployAt,
    `the previous version is recorded at step ${recordAt} and the deploy is at ${deployAt}; recording afterwards rolls back to the version that just failed`,
  );

  // 100% traffic, explicitly: `wrangler versions deploy <id>` without a
  // percentage is ambiguous and prompts, and a prompt in CI is an empty deploy
  // that reports a successful rollback.
  assert.match(steps, /wrangler versions deploy "\$\{\{ steps\.record-previous\.outputs\.version-id \}\}@100"/);
  assert.match(steps, /if: steps\.smoke\.outcome == 'failure'/);

  // Two rollback-triggered steps: one deploys the old version, one fails the
  // job. A single `if: failure()` step that rolled back and exited 0 would
  // report a green release over a version that is not serving.
  assert.match(steps, /- name: Roll back to the previous version/);
  assert.match(steps, /- name: Fail the release/);
  assert.match(steps, /exit 1/);

  // The smoke must be able to fail without skipping the rollback, which is what
  // `continue-on-error` plus `outcome` buys: a plain failed step skips every
  // later step that lacks `if: always()`.
  const smokeStep = steps.slice(
    steps.indexOf("- name: Smoke test production"),
  );
  assert.match(
    smokeStep,
    /continue-on-error: true/,
    "the production smoke must be continue-on-error so the rollback step after it still runs",
  );
});

test("production smoke is explicitly permitted against the apex domain", () => {
  // smoke.sh refuses https://nessebarlens.com without this. That guard exists
  // so a mistyped base URL in a preview job cannot quietly smoke production;
  // the release job is the one caller that means it.
  const body = jobs(release!).production;
  const smoke = body.slice(body.indexOf("- name: Smoke test production"));
  assert.match(smoke, /SMOKE_ALLOW_PRODUCTION: "1"/);
});

test("the build is a matrix over both environments, not one shared artifact", () => {
  const body = jobs(release!).build;
  // Comments are allowed between the key and its value, so the assertion is on
  // the key/value pair rather than on them being adjacent lines.
  assert.match(
    body,
    /strategy:(?:[^\n]*\n(?: {6}[^\n]*\n)*?) {6}fail-fast: false/,
  );
  assert.match(body, /matrix:/);
  // Both legs named, and each with its own origin so the deploy job can check
  // what it downloaded.
  assert.match(body, /- env: staging\s*\n\s+origin: https:\/\/staging\.nessebarlens\.com/);
  assert.match(body, /- env: production\s*\n\s+origin: https:\/\/nessebarlens\.com/);
  // fail-fast: false because a cancelled leg takes its artifact with it and the
  // deploy job that needed it fails on a missing download rather than on the
  // real cause.
  // Per-leg environment, so each build reads its own NEXT_PUBLIC_* values.
  assert.match(body, /environment: \$\{\{ matrix\.env \}\}/);
});

test("each deploy job checks the artifact it downloaded is its own", () => {
  const body = jobs(release!);
  for (const job of ["staging", "production"]) {
    const steps = body[job];
    // Both directions: the expected origin present, the other one absent.
    assert.match(steps, /assert-artifact-origin\.sh \.open-next "\$EXPECTED_ORIGIN" "\$FORBIDDEN_ORIGIN"/);
    // The artifact is a zip round-trip, so the tree is checked for content too.
    // This runs before the deploy, so a mangled artifact is a red job rather
    // than a deployed tree nobody built.
    assert.ok(
      stepIndex(steps, "Verify the downloaded build") <
        stepIndex(steps, "Apply D1 migrations"),
      `${job} must verify the downloaded artifact before migrating and deploying`,
    );
    assert.match(steps, /FORBIDDEN_ORIGIN: https:\/\/(staging\.)?nessebarlens\.com/);
  }
  // The staging job's forbidden origin is production's and vice versa, not a
  // copy of its own — a self-referential FORBIDDEN_ORIGIN would make the check
  // permanently fail, which reads as "the check is broken" and gets deleted.
  assert.match(body.staging, /FORBIDDEN_ORIGIN: https:\/\/nessebarlens\.com/);
  assert.doesNotMatch(body.staging, /FORBIDDEN_ORIGIN: https:\/\/staging\.nessebarlens\.com/);
  assert.match(body.production, /FORBIDDEN_ORIGIN: https:\/\/staging\.nessebarlens\.com/);
});

test("no deploy job rebuilds; the verified artifact is what ships", () => {
  const body = jobs(release!);
  for (const job of ["staging", "production"]) {
    assert.doesNotMatch(
      body[job],
      /opennextjs-cloudflare build/,
      `${job} rebuilds. The matrix exists so production does not build twice; a rebuild here also re-bakes NEXT_PUBLIC_* from this job's environment instead of shipping the artifact that was verified`,
    );
    assert.match(body[job], /opennextjs-cloudflare deploy/);
  }
});

test("a red run on main opens an incident and a green one closes it", () => {
  const body = jobs(release!);
  for (const job of ["notify", "resolve"]) {
    assert.match(
      body[job] ?? "",
      /uses: \$\/\.github\/workflows\/notify-failure\.yml/,
      `release.yml has no ${job} job calling notify-failure.yml — a red run on main would notify nobody`,
    );
  }
  // Every job that can fail, so a failing `checks` or `build` pages too rather
  // than only the deploy step.
  assert.deepEqual(
    needed(release!, "notify").sort(),
    ["build", "checks", "production", "staging"],
  );
  assert.match(body.notify, /^ {4}if: failure\(\) && github\.ref == 'refs\/heads\/main'$/m);
  assert.match(body.resolve, /^ {4}if: success\(\) && github\.ref == 'refs\/heads\/main'$/m);
  assert.match(body.resolve, /close: true/);
});

test("release.yml never runs the browser flow", () => {
  // Owned by ci.yml, and pinned pull_request-only there. A browser run here
  // would be a second run of a tree that already passed one on its PR.
  assert.doesNotMatch(release!, /playwright|npm run test:e2e/);
});
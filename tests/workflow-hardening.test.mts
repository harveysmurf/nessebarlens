/**
 * Issue #165: the four non-injection zizmor classes were real work, and real
 * work with no test is work that quietly comes back. This file pins each one
 * against the workflow sources so the audit cannot rot:
 *
 *   unpinned-uses            every third-party action is a 40-char SHA + a
 *                            `# vX.Y.Z` comment naming the release it came from
 *   excessive-permissions    every workflow declares `permissions:`, and every
 *                            job either inherits that or declares its own
 *   artipacked                every checkout sets `persist-credentials: false`
 *   self-repository          same-repo references use `$/`, which resolves at
 *                            the running commit instead of the workspace
 *
 * The last one is the one with a subtlety worth stating: `./` resolves against
 * whatever is checked out, so a job that uses it can silently run a different
 * commit's composite action than the one it checked out. `$/` cannot.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");
const actionDir = path.join(root, ".github", "actions");

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowDir, name), "utf8"),
  }));

const compositeActions = fs
  .readdirSync(actionDir)
  .flatMap((dir) => {
    const action = path.join(actionDir, dir, "action.yml");
    return fs.existsSync(action)
      ? [{ name: `${dir}/action.yml`, text: fs.readFileSync(action, "utf8") }]
      : [];
  });

const everyDefinition = [...workflows, ...compositeActions];
const usesLines = everyDefinition.flatMap(({ name, text }) =>
  [...text.matchAll(/^([ \t]*)(?:-[ \t]+)?uses:[ \t]*(.+)$/gm)].map((match) => ({
    file: name,
    indent: match[1],
    ref: match[2].trim(),
  })),
);

const SHA = /@[0-9a-f]{40}(?:[ \t]*#.*)?$/;
const versionComment = /#[ \t]*v\d+\.\d+\.\d+/;

/** `owner/repo[/path]@ref` — anything not `./` or `$/`, i.e. someone else's code. */
const isThirdParty = (ref: string) => !/^\.\//.test(ref) && !/^\$\//.test(ref);

test("every third-party action is SHA-pinned with the version it came from", () => {
  const unpinned = usesLines
    .filter(({ ref }) => isThirdParty(ref) && !SHA.test(ref))
    .map(({ file, ref }) => `${file}: ${ref}`);
  assert.deepEqual(unpinned, [], `unpinned action references:\n${unpinned.join("\n")}`);

  const undocumented = usesLines
    .filter(({ ref }) => isThirdParty(ref) && !versionComment.test(ref))
    .map(({ file, ref }) => `${file}: ${ref}`);
  assert.deepEqual(
    undocumented,
    [],
    `a SHA with no version comment is unauditable six months from now:\n${undocumented.join("\n")}`,
  );
});

test("no same-repo reference uses the workspace-relative ./ form", () => {
  const relative = usesLines
    .filter(({ ref }) => ref.startsWith("./"))
    .map(({ file, ref }) => `${file}: ${ref}`);
  assert.deepEqual(
    relative,
    [],
    `use $/ so the reference resolves at the running commit:\n${relative.join("\n")}`,
  );
});

test("every checkout drops the persisted token", () => {
  const checkouts = usesLines.filter(({ ref }) => ref.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0, "no checkout found -- the glob went stale");

  for (const { file } of checkouts) {
    const definition = everyDefinition.find((candidate) => candidate.name === file);
    assert.ok(definition, `${file} has a checkout but no definition`);
    const lines = definition.text.split("\n");
    const index = lines.findIndex((line) =>
      /^\s*(?:-[ \t]+)?uses:[ \t]*actions\/checkout@/.test(line),
    );
    assert.ok(index >= 0, `${file}: checkout line not found`);
    const step = lines.slice(index, index + 3).join("\n");
    assert.match(
      step,
      /persist-credentials:[ \t]*false/,
      `${file}: checkout at line ${index + 1} leaves the token in .git/config, where it lands in any later artifact`,
    );
  }
});

test("every workflow declares permissions, so the default token is not write-all", () => {
  for (const { name, text } of workflows) {
    const header = text.slice(0, text.search(/^jobs:[ \t]*$/m));
    assert.match(
      header,
      /^permissions:[ \t]*$/m,
      `${name} has no workflow-level permissions block`,
    );
    assert.match(
      header,
      /^ {2}contents:[ \t]*read[ \t]*$/m,
      `${name} does not start from contents: read`,
    );
  }
});

test("a job that writes to the GitHub API declares the permission to do it", () => {
  // The preview comment step posts and updates an issue comment. If the
  // workflow-level default were ever raised instead of overridden, or the
  // job-level `pull-requests: write` were dropped as redundant, the step
  // fails with a permission error that reads like a flake — so the pairing is
  // pinned from both sides: writes present, and the scope declared for them.
  const writers = workflows.filter((workflow) =>
    /github\.rest\.issues\.(createComment|updateComment)/.test(workflow.text),
  );
  assert.ok(writers.length > 0, "no workflow writes an issue comment any more");

  for (const { name, text } of writers) {
    const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
    for (const block of jobsText.split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1)) {
      if (!/github\.rest\.issues\.(createComment|updateComment)/.test(block)) continue;
      assert.match(
        block,
        /^ {6}pull-requests:[ \t]*write[ \t]*$/m,
        `${name}: a job comments on the pull request but does not declare pull-requests: write`,
      );
    }
  }
});

/**
 * #199: production failed ten times in a day and the reconcile cron six times
 * without telling anyone, because a red run on `main` is silent. The fix is a
 * reusable notify workflow called from a final job of every workflow that can
 * break main by itself — which is the set this test now pins.
 *
 * "Deploys or runs on a schedule" is read from the workflow text rather than a
 * hand-maintained list, because a list is exactly what stops matching: the next
 * deploy workflow would be added to `.github/workflows/` and not to the list,
 * and the failure mode being guarded against is a workflow nobody reads.
 */
const deploysOrScheduled = workflows.filter(({ name, text }) =>
  // notify-failure.yml is the mechanism itself, and preview.yml deploys on
  // pull_request where the PR is the notification.
  name !== "notify-failure.yml" &&
  name !== "preview.yml" &&
  // `production:` is release.yml's production deploy job: since #200 merged
  // staging.yml and prod.yml into one ordered pipeline, neither half is named
  // `deploy:` any more, and the reconciler cron moved off GitHub (#201), so the
  // only remaining match would be verify-stripe.yml and the `>= 2` guard below
  // would read as stale detection when it is actually a changed workflow set.
  (/\n {2}(deploy|production):/m.test(text) || /^ {2}schedule:\s*$/m.test(text)),
);

test("every workflow that deploys or runs on a schedule notifies on failure", () => {
  assert.ok(
    deploysOrScheduled.length >= 2,
    "no deploy or scheduled workflow matched — the detection went stale",
  );

  for (const { name, text } of deploysOrScheduled) {
    // Same job-block split the permission test above uses: a job key starts at
    // two spaces and a new one starts at the next such line.
    const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
    const notifyJobs = jobsText
      .split(/\n {2}(?=[a-z][\w-]*:\n)/)
      .slice(1)
      .filter((block) =>
        /uses:[ \t]*\$\/\.github\/workflows\/notify-failure\.yml/.test(block),
      );

    assert.ok(
      notifyJobs.length > 0,
      `${name} deploys or runs on a schedule but has no job calling .github/workflows/notify-failure.yml — a red run on main would notify nobody`,
    );

    // Opening the incident is not enough: without the closing job the tracker
    // fills with open incidents that nobody can tell are live.
    assert.ok(
      notifyJobs.some((block) => /close:[ \t]*true/.test(block)),
      `${name} opens an incident but never closes it — pass close: true from a success() job`,
    );
    assert.ok(
      notifyJobs.some((block) => /^ {4}if:[ \t]*failure\(\)/m.test(block)),
      `${name} has no if: failure() guard, so the notify job runs on every successful deploy and comments on its own incident`,
    );

    // The incident signal is about main. Every one of these workflows is
    // dispatchable on a branch, and a green branch run reaching `resolve` would
    // close a live main incident with a "recovered" comment — a false negative
    // on exactly the thing this pair of jobs exists to raise.
    for (const block of notifyJobs) {
      assert.match(
        block,
        /^ {4}if:[ \t]*(failure|success)\(\)[ \t]*&&[ \t]*github\.ref ==[ \t]*'refs\/heads\/main'[ \t]*$/m,
        `${name} has a notify-failure job without the refs/heads/main guard — a dispatch on another branch would close a live incident`,
      );
    }
  }
});

test("only the notify workflow's job may write issues, and it says so", () => {
  // The calling workflows hold deploy credentials; widening their top-level
  // default to `issues: write` to save a declaration on the notify job would
  // hand every one of them the ability to edit the tracker. The scope has to
  // stay on the job that uses it.
  const notify = workflows.find(({ name }) => name === "notify-failure.yml");
  assert.ok(notify, "notify-failure.yml is missing — nothing can notify");

  assert.match(notify.text, /^ {6}issues:[ \t]*write[ \t]*$/m);
  assert.match(
    notify.text,
    /^ {4}permissions:\n {6}contents: read\n {6}issues: write$/m,
    "notify-failure.yml must raise issues: write on the notify job only, over a contents: read default",
  );

  for (const { name, text } of workflows) {
    if (name === "notify-failure.yml") continue;
    assert.doesNotMatch(
      text,
      /^ {2}issues:[ \t]*write[ \t]*$/m,
      `${name} grants issues: write at the workflow level — the notify workflow declares its own`,
    );
  }

  // The other half of the same rule, and the one #206 got wrong: a called
  // workflow cannot hold a permission the CALLER did not grant. Declaring
  // `issues: write` here while every caller tops out at `contents: read` made
  // GitHub reject notify-failure.yml at startup, so all four callers died with
  // `startup_failure` and zero jobs — no log, no annotation, and the whole
  // release pipeline looked broken for an unrelated reason.
  //
  // This assertion is about the *callers*, which is why it did not exist: the
  // suite was green while production deploys were startup-failing on main.
  // Three callers, not four: #200 merged staging.yml and prod.yml into
  // release.yml. Asserted as a floor so a workflow silently dropping the call
  // is a failure rather than a smaller number quietly passing.
  const callers = workflows.filter((w) =>
    /^ {4}uses:[ \t]*\$\/\.github\/workflows\/notify-failure\.yml[ \t]*$/m.test(w.text),
  );
  assert.ok(
    callers.length >= 3,
    `expected at least 3 workflows to call notify-failure.yml, found ${callers.length}: ${workflows
      .map((w) => w.name)
      .join(", ")}`,
  );

  for (const { name, text } of callers) {
    for (const job of ["notify", "resolve"]) {
      const block = text.match(
        new RegExp(`^ {2}${job}:\\n((?:(?: {4}|\\t).*\\n|\\n)*)`, "m"),
      );
      assert.ok(block, `${name} calls notify-failure.yml but has no ${job} job`);
      assert.match(
        block[1],
        /^ {4}permissions:\n {6}contents: read\n {6}issues: write$/m,
        `${name}'s ${job} job calls notify-failure.yml, which writes issues, but the job does not grant issues: write. A called workflow cannot hold a permission its caller did not grant, so notify-failure.yml is rejected at startup and this workflow fails with startup_failure and zero jobs.`,
      );
      // Job-scoped, not workflow-scoped: the deploy and cron jobs in these same
      // files must not gain the ability to edit the tracker.
      assert.doesNotMatch(
        text.slice(0, text.search(/^ {2}\w[\w-]*:\n/m) + 1),
        /^ {2}issues: write$/m,
        `${name} grants issues: write at the workflow level instead of on ${job}`,
      );
    }
  }
});

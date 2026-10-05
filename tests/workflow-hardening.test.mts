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
  (/\n {2}deploy:/m.test(text) || /^ {2}schedule:\s*$/m.test(text)),
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
});

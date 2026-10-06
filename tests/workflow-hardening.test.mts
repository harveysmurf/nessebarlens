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

test("no workflow runs on a floating runner label", () => {
  // #205 item 4: `ubuntu-latest` migrates to Ubuntu 26 on 2026-10-19, and a
  // runner image is not just a kernel bump — it moves OpenSSL, glibc, and the
  // package list `playwright install --with-deps` installs. Those changes would
  // arrive inside a production deploy, on a day nobody is looking at CI, which
  // is the worst possible moment for a runner change to become a smoke failure.
  //
  // Moving to 26.04 is not forbidden, it is just not something a label edit
  // should do: do it in its own PR, after the e2e jobs are green on it.
  const floating = everyDefinition.flatMap(({ name, text }) =>
    [...text.matchAll(/^([ \t]*)runs-on:[ \t]*(.+)$/gm)]
      .filter(([, , value]) => /ubuntu-latest|ubuntu-latest-\S+/.test(value.trim()))
      .map(() => name),
  );
  assert.deepEqual(
    [...new Set(floating)],
    [],
    "these definitions run on ubuntu-latest, which GitHub migrates to Ubuntu 26 on 2026-10-19 — pin ubuntu-24.04 and move to 26.04 deliberately",
  );

  // A reader that silently stopped matching would make the assertion above
  // vacuously true, which is how a check like this dies unnoticed. Floors
  // rather than a count per file, because the job set legitimately changes.
  const runnerLines = workflows.flatMap(({ text }) =>
    [...text.matchAll(/^[ \t]*runs-on:[ \t]*(.+)$/gm)].map(([, value]) => value.trim()),
  );
  assert.ok(
    runnerLines.length >= 8,
    `found ${runnerLines.length} runs-on lines across ${workflows.length} workflows — the scan above is reading nothing`,
  );
  assert.ok(
    runnerLines.every((value) => value === "ubuntu-24.04"),
    `every runs-on must be exactly ubuntu-24.04; found: ${[...new Set(runnerLines)].join(", ")}`,
  );
});

test("Dependabot's own pin format is what the SHA test above accepts", () => {
  // #205 item 2 added the github-actions ecosystem, which means SHA pins are now
  // written by a bot rather than by hand. Dependabot rewrites the ref and keeps
  // the `# vX.Y.Z` comment, so the two assertions in "every third-party action is
  // SHA-pinned" keep holding — but only for the exact comment shape it emits.
  // If a future Dependabot writes `# v6` or drops the comment, its PR fails this
  // test rather than arriving as a red CI run nobody can explain.
  //
  // Pinned as fixtures rather than as a live run: the point is the format, and a
  // test that calls the API to check it would be a network-dependent test in a
  // suite that has none.
  const dependabotWrites = [
    "actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0",
    "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0",
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0",
  ];
  for (const ref of dependabotWrites) {
    assert.ok(SHA.test(ref), `SHA pattern rejects Dependabot's output: ${ref}`);
    assert.ok(
      versionComment.test(ref),
      `version-comment pattern rejects Dependabot's output: ${ref}`,
    );
  }

  // And the inverse, so the patterns above cannot be loosened into uselessness
  // to accommodate the bot: an unpinned or uncommented ref is still rejected.
  assert.equal(SHA.test("actions/checkout@v5"), false);
  assert.equal(versionComment.test("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8"), false);
});

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

/**
 * Issue #202: `preview.yml` uploaded with no `--env`, so every PR preview was a
 * *version of the production Worker* and inherited its bindings —
 * `ORDERS_DB` = `nessebar-lens-orders`, `MASTERS` = the real masters bucket.
 * A preview runs unreviewed PR code, so a sandbox purchase on one wrote to the
 * production orders table.
 *
 * This is asserted per *invocation*, not per file, because the flag is the
 * thing that regresses and a file-level grep cannot say which job regressed or
 * whether the exemption is the production leg or something else entirely.
 */
const uploadOrVersions =
  /(?:npx\s+)?(?:opennextjs-cloudflare\s+(?:upload|deploy)|wrangler\s+versions\s+(?:list|delete|deploy))/g;

/** Each command invocation with its `\` continuations folded into one string. */
const invocations = (script: string): string[] => {
  const lines = script.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const first = lines[i];
    if (!uploadOrVersions.test(first)) {
      // `g` is stateful across .test() calls; reset before reusing.
      uploadOrVersions.lastIndex = 0;
      continue;
    }
    uploadOrVersions.lastIndex = 0;
    let command = first.trim();
    while (command.endsWith("\\") && i + 1 < lines.length) {
      i += 1;
      command = `${command} ${lines[i].trim()}`;
    }
    found.push(command);
  }
  return found;
};

/** `{ job, command }` for every upload/deploy/versions call in every workflow. */
const allDeployInvocations = workflows.flatMap(({ name, text }) => {
  const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
  if (!jobsText) return [];
  return jobsText
    .split(/\n {2}(?=[a-z][\w-]*:\n)/)
    .slice(1)
    .flatMap((block) => {
      const job = block.match(/^([a-z][\w-]*):\n/)?.[1] ?? "?";
      return invocations(block).map((command) => ({
        workflow: name,
        job,
        command,
      }));
    });
});

test("every upload/deploy/versions call is read out of a known job, not missed by the reader", () => {
  // A reader that silently stopped matching would make every assertion below
  // vacuously true, which is how a check like this dies unnoticed.
  const summary = allDeployInvocations.map(
    ({ workflow, job, command }) => `${workflow}/${job}: ${command.split(/\s+/).slice(0, 3).join(" ")}`,
  );
  assert.ok(
    summary.length >= 5,
    `found ${summary.length} deploy invocations, expected at least 5:\n${summary.join("\n")}`,
  );
  assert.ok(
    summary.some((s) => s.startsWith("preview.yml/deploy:")),
    "preview.yml's upload step is no longer visible to the reader — the #202 assertions cannot fail if they do not see it",
  );
});

test("only release.yml's production leg may omit --env staging", () => {
  // `release.yml`'s production job is the one legitimate omission: the
  // top-level bindings in wrangler.toml ARE production, and `--env staging`
  // there would deploy the wrong tree. Everything else — preview uploads, the
  // cleanup list/delete, the staging deploy, any future workflow — must name
  // the environment, because an unnamed environment is production.
  const unnamed = allDeployInvocations
    .filter(({ command }) => !/--env[= ]+staging/.test(command))
    .map(({ workflow, job }) => `${workflow}/${job}`);

  // Exactly the production job: the deploy itself and the rollback it performs
  // on a failed smoke. Both are production, by definition — the rollback
  // restores the version production was serving.
  assert.deepEqual(
    [...new Set(unnamed)].sort(),
    ["release.yml/production"],
    `these wrangler calls omit --env staging: ${JSON.stringify(unnamed)}. Every call outside release.yml's production leg must pass it — an upload with no --env targets the top-level Worker, so a PR preview inherits production's D1 and R2 bindings and unreviewed code can write to production orders`,
  );
});

test("a preview's version URL is asserted to be a staging version, not read off the source", () => {
  // `--env staging` in the upload is necessary but not sufficient evidence: a
  // green upload proves a version exists, not which worker it belongs to. The
  // hostname is the observable — `x-nessebar-lens-staging.<sub>.workers.dev` vs
  // `x-nessebar-lens.<sub>.workers.dev` — so the step checks it and fails.
  const preview = workflows.find(({ name }) => name === "preview.yml")!;
  const deploy = allDeployInvocations.filter(
    ({ workflow, job }) => workflow === "preview.yml" && job === "deploy",
  );
  assert.equal(deploy.length, 1, `expected one upload in preview.yml/deploy, got ${deploy.length}`);

  const block = preview.text.slice(preview.text.search(/^jobs:[ \t]*$/m));
  assert.match(
    block,
    /case "\$url" in\n\s+\*-nessebar-lens-staging\.\*\) ;;/,
    "preview.yml must assert the reported preview URL belongs to nessebar-lens-staging — that assertion is what turns a lost --env into a red job instead of a production-bound preview",
  );
  assert.match(
    block,
    /::error::preview URL \$url is not a nessebar-lens-staging version URL/,
    "the assertion must name the failure it catches",
  );
});

test("the preview's own D1 is staging's, which is what makes the isolation real", () => {
  // Half a rule again: `--env staging` on every call is only worth anything if
  // [env.staging] actually points somewhere other than production. If someone
  // edits wrangler.toml to reuse the production database id, every CI check
  // still passes and previews write to production again.
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const envStaging = toml.slice(toml.search(/^\[env\.staging\]\s*$/m));
  const prodDbId = toml.match(/^database_id = "([^"]+)"$/m)?.[1];
  const stagingDbId = envStaging.match(/^database_id = "([^"]+)"$/m)?.[1];

  assert.ok(prodDbId && stagingDbId, "could not read both database ids from wrangler.toml");
  assert.notEqual(
    stagingDbId,
    prodDbId,
    "[env.staging] binds the PRODUCTION database id — a preview uploaded with --env staging would still write to nessebar-lens-orders",
  );
  assert.match(envStaging, /database_name = "nessebar-lens-orders-staging"/);
});

test("a version with no preview URL names the setting that has to change", () => {
  // #202's rollout blocker, found by running it: nessebar-lens-staging has
  // version previews disabled, so wrangler uploads the version and prints no
  // `Version Preview URL` line at all. A single "no version id / preview URL"
  // error for both cases reads like a wrangler output change and sends the next
  // person looking for a parser bug instead of a Worker setting.
  const preview = workflows.find(({ name }) => name === "preview.yml")!.text;
  assert.match(
    preview,
    /if \[\[ -n "\$vid" && -z "\$url" \]\]; then/,
    "preview.yml must have a branch for 'uploaded a version but got no preview URL' — it is a different failure from 'upload printed nothing', with a different cause",
  );
  assert.match(
    preview,
    /but wrangler printed no Version Preview URL -- version previews are disabled for that Worker/,
    "that branch must name version previews as the cause, so the next person reads a setting name instead of hunting a wrangler parsing bug",
  );
  // And the fix must stay out of the job: this runs on unreviewed PR code with
  // the staging Cloudflare token, so it must not be the thing that mutates
  // Worker settings.
  assert.doesNotMatch(
    preview,
    /curl[^\n]*\/subdomain|npx wrangler[^\n]*subdomain/,
    "preview.yml must not write Worker subdomain settings — this job runs unreviewed pull_request code with the staging Cloudflare token. The endpoint may appear in an error message; a call may not",
  );
});

test("staging deploys keep version previews on (preview_urls = true)", () => {
  // The upload in preview.yml reads a `Version Preview URL`, which wrangler only
  // prints when the staging Worker's account-side `previews_enabled` is on. But
  // wrangler's `preview_urls` config defaults to false, and release.yml runs
  // `opennextjs-cloudflare deploy --env staging` on every main push, re-applying
  // subdomain settings from this file. Without the key each release silently
  // clears the flag, so the next PR's preview is the one that reds — that is
  // exactly the #230 failure (2026-10-05): #229 previewed green at 17:50, the
  // release ran at 17:56, and the next preview got no URL. It must live under
  // [env.staging], not the top level: environments do not inherit it.
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const envStaging = toml.slice(toml.search(/^\[env\.staging\]\s*$/m));
  const nextSection = envStaging.search(/^\[env\.staging\./m);
  const block = nextSection === -1 ? envStaging : envStaging.slice(0, nextSection);
  assert.match(
    block,
    /^preview_urls = true$/m,
    "[env.staging] must set preview_urls = true — otherwise every staging deploy clears the Worker's version previews and preview.yml reds until someone re-enables the account flag by hand",
  );
});

test("the shared masters binding is documented as full access, not read-only", () => {
  // #202 item 4, decided option (a): staging and previews keep the production
  // masters bucket so the full-purchase rehearsal renders real photos and signs
  // real print assets. That decision is only safe to leave in a comment that
  // states its actual toll. An earlier comment here claimed the code "only
  // READS" the bucket — an R2 binding has no read-only mode, so a preview holds
  // read+write+delete on production masters plus print-asset signing, and the
  // only control is review of unreviewed PR code. A reassuring comment about an
  // invariant previews exist to break is worse than no comment.
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const envStaging = toml.slice(toml.search(/^\[env\.staging\]\s*$/m));
  // The whole [env.staging] tail — the shared-bucket comment sits above the
  // MASTERS binding, after d1_databases, not directly under the section head.
  const comment = envStaging;

  assert.match(
    envStaging,
    /bucket_name = "nessebar-lens-masters"/,
    "[env.staging] must keep the production masters bucket — option (a), per Simo 2026-10-05. If this now names a -staging bucket, the seeding step is required too or every miss renders the committed placeholder and signs print assets from placeholders",
  );
  assert.doesNotMatch(
    comment,
    /only READS? them\b(?![^#]*NOT)/i,
    "the staging comment must not claim the code only reads the shared buckets — that is a TypeScript type, not an enforced control",
  );
  assert.match(
    comment,
    /no\s*\n?(?:#\s*)?read-only mode/,
    "the comment must say an R2 binding is full read+write+delete, since that is the risk a future reader has to weigh",
  );
});

/**
 * Issue #224: Dependabot-triggered runs receive no Actions or Environment
 * secrets, so any job that reads `secrets.*` on a pull_request trigger fails on
 * every `dependabot[bot]` push — the secret resolves empty, the guard step (or
 * the build) reds, and the failure is indistinguishable from a real regression.
 * The fix is a `github.actor != 'dependabot[bot]'` guard on the job's `if:`,
 * which makes a Dependabot run skip instead of fail. This test pins that guard
 * so a new secret-reading job on a pull_request trigger cannot reintroduce the
 * red by omission.
 *
 * Scoped to pull_request triggers. release.yml, reconcile.yml and
 * verify-stripe.yml run on push/schedule/workflow_dispatch, where the actor is
 * the deploy pipeline or a human and Dependabot never fires them, so a guard
 * there would be dead code and is deliberately not required.
 */
test("every secret-reading job on a pull_request trigger skips Dependabot runs", () => {
  const pullRequestSecretJobs = workflows.flatMap(({ name, text }) => {
    const header = text.slice(0, text.search(/^jobs:[ \t]*$/m));
    if (!/^ {2}pull_request:/m.test(header)) return [];
    const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
    return jobsText
      .split(/\n {2}(?=[a-z][\w-]*:\n)/)
      .slice(1)
      .filter((block) => /secrets\.[A-Z0-9_]+/.test(block))
      .map((block) => {
        const job = block.match(/^([a-z][\w-]*):\n/)?.[1] ?? "?";
        return { workflow: name, job, block };
      });
  });

  // A reader that silently stopped matching would make the assertion below
  // vacuously true, which is how a check like this dies unnoticed. Floor
  // rather than exact count, because the job set legitimately changes.
  assert.ok(
    pullRequestSecretJobs.length >= 3,
    `expected at least 3 secret-reading jobs on pull_request workflows, found ${pullRequestSecretJobs.length}: ${pullRequestSecretJobs.map((j) => `${j.workflow}/${j.job}`).join(", ")}`,
  );

  const unguarded = pullRequestSecretJobs
    .filter(({ block }) => !/github\.actor\s*!=\s*'dependabot\[bot\]'/.test(block))
    .map(({ workflow, job }) => `${workflow}/${job}`);
  assert.deepEqual(
    unguarded,
    [],
    `these jobs read secrets on a pull_request trigger but do not skip Dependabot runs with \`github.actor != 'dependabot[bot]'\`:\n${unguarded.join("\n")}`,
  );
});

/**
 * Issue #225: a Dependabot PR runs without secrets, so what keeps a bump from
 * landing unverified is a small triage workflow and a post-merge backstop. Both
 * hold a write-scoped token, so what they can reach is pinned the same way the
 * rest of the audit is: from the workflow text, so a loosening is a red test
 * and not a quiet review comment.
 */
const workflowText = (file: string): string => {
  const found = workflows.find(({ name }) => name === file);
  assert.ok(found, `${file} is missing`);
  return found.text;
};

/** `permissions:` entries of a block whose `permissions:` key is at `indent`. */
const permissionsAt = (text: string, indent: number): string[] => {
  const pad = " ".repeat(indent);
  const match = text.match(new RegExp(`^${pad}permissions:[ \\t]*\\n((?:${pad}  .*\\n)+)`, "m"));
  assert.ok(match, `no permissions block at indent ${indent}`);
  return match[1]
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => line.trim().replace(/\s+/g, " "))
    .sort();
};

/** The text of one top-level job, header line included. */
const jobBlock = (text: string, job: string): string => {
  const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
  const block = jobsText
    .split(/\n {2}(?=[a-z][\w-]*:\n)/)
    .slice(1)
    .find((candidate) => candidate.startsWith(`${job}:\n`));
  assert.ok(block, `job ${job} not found`);
  return block;
};

/** Every `run:` body (inline or block scalar) in a workflow. */
const runBodies = (text: string): string[] => {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^( *)(?:- )?run:[ \t]*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (!/^[|>][+-]?$/.test(m[2])) {
      bodies.push(m[2]);
      continue;
    }
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^ */.exec(lines[i + 1])![0].length > indent + 1)) {
      i += 1;
      body.push(lines[i]);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
};

test("dependabot-triage.yml reads no secrets", () => {
  // Out of scope in #225, and the point of the design: bump PRs must not run
  // with credentials before review. The job token is not a secret in this
  // sense; `github.token` is the only credential and it is scoped below.
  assert.doesNotMatch(workflowText("dependabot-triage.yml"), /\bsecrets\./);
  assert.doesNotMatch(workflowText("release-backstop.yml"), /\bsecrets\./);
});

test("dependabot-triage.yml starts from contents: read and raises exactly two scopes on its job", () => {
  const text = workflowText("dependabot-triage.yml");
  assert.deepEqual(permissionsAt(text, 0), ["contents: read"]);
  assert.deepEqual(
    permissionsAt(jobBlock(text, "triage"), 4),
    ["contents: write", "pull-requests: write"],
    "the triage job needs contents: write (auto-merge) and pull-requests: write (label, comment) and nothing else -- no issues, actions or id-token",
  );
});

test("the triage job runs only for Dependabot, as Dependabot", () => {
  // `user.login` alone would also fire for a human's push to a Dependabot branch
  // (the rehearsal step), re-enabling auto-merge on a branch now holding a
  // human's commit. `actor` alone would fire for a human re-running a PR. Both.
  const text = workflowText("dependabot-triage.yml");
  const condition = jobBlock(text, "triage").match(/^ {4}if:[ \t]*(.+)$/m)?.[1] ?? "";
  assert.match(condition, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  assert.match(condition, /github\.actor == 'dependabot\[bot\]'/);
  assert.match(condition, /&&/);
  assert.doesNotMatch(condition, /\|\|/, "an OR here would let one half stand in for the other");
});

test("auto-merge is reachable only for routine groups at patch/minor", () => {
  const text = workflowText("dependabot-triage.yml");

  const step = text.match(/- name: Enable auto-merge\n([\s\S]*?)(?=\n {6}- name:|$)/)?.[1];
  assert.ok(step, "Enable auto-merge step not found");
  assert.match(step, /steps\.classify\.outputs\.class == 'routine'/);
  assert.match(step, /update-type == 'version-update:semver-patch'/);
  assert.match(step, /update-type == 'version-update:semver-minor'/);
  assert.doesNotMatch(step, /semver-major/);
  // Exactly one `gh pr merge` in the file: a second one elsewhere would be an
  // auto-merge path this test does not guard.
  assert.equal(
    runBodies(text).filter((body) => /gh pr merge/.test(body)).length,
    1,
  );

  const arms = [...text.matchAll(/^ {10}\s*([^\n\s]+?)\) class=routine;/gm)].map((m) => m[1]);
  assert.deepEqual(arms, ["dev-tooling|actions"], "only dev-tooling and actions may map to routine");
  assert.doesNotMatch(
    text.match(/case "\$GROUP" in([\s\S]*?)esac/)![1].replace(/^.*class=routine.*$/m, ""),
    /class=routine/,
    "a second arm maps to routine",
  );
});

test("dependabot-triage.yml has no expression inside a run: script", () => {
  // zizmor's template-injection gate is the machine check; this keeps the
  // property visible in the unit suite too. Values reach a script through env.
  const bodies = runBodies(workflowText("dependabot-triage.yml"));
  assert.ok(bodies.length >= 3, `found ${bodies.length} run bodies -- the reader is reading nothing`);
  for (const body of bodies) {
    assert.doesNotMatch(body, /\$\{\{/, `expression inside run:\n${body}`);
  }
});

test("release-backstop.yml dispatches release.yml with the narrowest token", () => {
  const text = workflowText("release-backstop.yml");
  assert.deepEqual(permissionsAt(text, 0), ["contents: read"]);
  assert.deepEqual(
    permissionsAt(jobBlock(text, "backstop"), 4),
    ["actions: write", "contents: read"],
  );
  assert.match(text, /gh workflow run release\.yml\b/);
  assert.match(text, /--commit "\$sha"/, "the check must be per commit, not 'any run today'");
  assert.match(text, /^ {2}schedule:\s*$/m);
  assert.match(text, /^ {2}workflow_dispatch:/m);
  for (const body of runBodies(text)) {
    assert.doesNotMatch(body, /\$\{\{/, `expression inside run:\n${body}`);
  }
});

test("release.yml treats a Dependabot merge like any other (#225 step 5)", () => {
  // "No special-casing": the same pipeline, the same gates. The one thing that
  // differs for a merge made with GITHUB_TOKEN is whether the push trigger
  // fires, and release-backstop.yml covers that without touching this file.
  const text = workflowText("release.yml");
  const header = text.slice(0, text.search(/^jobs:[ \t]*$/m));
  assert.match(header, /^ {2}push:\s*\n {4}branches: \[main\]/m);
  assert.match(header, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(text, /dependabot/i, "release.yml special-cases Dependabot");
});

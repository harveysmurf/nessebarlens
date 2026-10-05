/**
 * Issue #205 item 2: every action is SHA-pinned and every runtime dependency
 * sits on the money or deploy path, but nothing moved a pin. A SHA does not
 * drift on its own, so "we pin" was doing no work until a bot was watching the
 * tags.
 *
 * This pins the shape of `.github/dependabot.yml` rather than its existence.
 * The two ways it can quietly stop helping are both invisible in a green suite:
 *
 *   * the config is deleted or renamed — no update ever arrives again, and
 *     nothing in CI notices because a missing bot produces no failures; and
 *   * a group is split, merged, or dropped, which is how `next` ends up bumped
 *     away from `react` and the tree breaks in a way no pin test can see.
 *
 * The group split is the part worth writing down. Dependabot groups exist so
 * packages that only work together move together: `next` with a stale `react`,
 * or `wrangler` with a stale `@opennextjs/cloudflare`, are broken upgrades
 * rather than partial ones. So the expected groups are asserted by name and by
 * membership, and a package that is neither explicitly grouped nor covered by a
 * catch-all is a failure — a new dependency added to package.json has to land
 * in one of these buckets on purpose.
 *
 * The stale-credential half of #205 is a different file: the expected secret
 * set per environment is in tests/workflow-secrets.test.mts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const configPath = path.join(root, ".github", "dependabot.yml");
assert.ok(
  fs.existsSync(configPath),
  ".github/dependabot.yml is missing — nothing moves a SHA pin or a runtime dependency any more, and no test or CI run will ever say so",
);

const config = fs.readFileSync(configPath, "utf8");

/** One `updates:` entry, from its `- package-ecosystem:` line to the next one. */
const updateBlocks = config
  .split(/\n {2}-[ \t]+package-ecosystem:/)
  .slice(1)
  .map((block) => `- package-ecosystem:${block}`);
const updateFor = (ecosystem: string): string => {
  const block = updateBlocks.find((candidate) =>
    candidate.includes(`package-ecosystem: ${ecosystem}`),
  );
  assert.ok(block, `dependabot.yml has no ${ecosystem} update block`);
  return block;
};

test("every ecosystem is updated on a weekly schedule", () => {
  // A bot with no schedule never runs, and a bot that only runs monthly is
  // worse than none for a dependency sitting on the deploy path: it produces a
  // reliably ignored PR.
  assert.match(config, /^version:[ \t]*2[ \t]*$/m, "dependabot.yml must declare version: 2");

  for (const ecosystem of ["github-actions", "npm"]) {
    const block = updateFor(ecosystem);
    assert.match(
      block,
      /^[ \t]*schedule:\n[ \t]*interval:[ \t]*weekly[ \t]*$/m,
      `the ${ecosystem} ecosystem must run weekly`,
    );
  }
});

test("security updates are not turned off", () => {
  // `insecure-external-code-execution: deny` is the safe default and needs no
  // spelling here. What must not appear is anything that stops a security update
  // from arriving: an `ignore` list covering a vulnerable package, or an
  // ecosystem-level `open-pull-requests-limit: 0`.
  assert.doesNotMatch(
    config,
    /^[ \t]*ignore:/m,
    "dependabot.yml carries an `ignore` list — a security update for an ignored package never arrives",
  );
  for (const block of updateBlocks) {
    assert.doesNotMatch(
      block,
      /open-pull-requests-limit:[ \t]*0[ \t]*$/m,
      "an open-pull-requests-limit of 0 means no PR is ever opened, so no update is ever applied",
    );
  }
});

test("actions are updated as one group, and only ever as SHA pins", () => {
  // One PR for the whole github-actions ecosystem, deliberately: the Node
  // runtime bump (checkout, setup-node) and the artifact pair that moves with
  // it only make sense together, and one-PR-per-action would open five PRs to
  // be merged in an order nobody chooses correctly.
  const block = updateFor("github-actions");
  assert.match(
    block,
    /^[ \t]*groups:\n[ \t]*actions:\n[ \t]*patterns:\n[ \t]*- "\*"[ \t]*$/m,
    "all action updates must land in a single `actions` group",
  );

  // Dependabot's github-actions updater rewrites SHA refs in place and keeps
  // the `# vX.Y.Z` comment, so adding this ecosystem does not weaken the pin
  // test. tests/workflow-hardening.test.mts pins that claim against fixtures.
  assert.doesNotMatch(
    block,
    /versioning-strategy:[ \t]*increase/m,
    "a versioning-strategy on actions would let Dependabot rewrite a SHA pin to a tag ref, which is exactly the unpinned form the hardening test bans",
  );
});

test("the one action Dependabot cannot see is named, so it is bumped by hand", () => {
  // Measured, not assumed: Dependabot's github-actions ecosystem scans
  // `.github/workflows/`, and its first run after this config merged (#217)
  // updated checkout, upload-artifact, download-artifact and github-script
  // across all six workflows while leaving `.github/actions/setup/action.yml`
  // untouched. There is no config that fixes this — the composite action is
  // outside the directory the ecosystem reads.
  //
  // So `setup-node` is the one pin in this repository that no bot maintains,
  // and the honest thing is to say which one it is. Read from the composite
  // action rather than hard-coded, so this fails if a second action ever lands
  // in a directory Dependabot ignores: the claim is "exactly one blind spot",
  // and it stops being true the moment there are two.
  const setupAction = fs.readFileSync(
    path.join(root, ".github", "actions", "setup", "action.yml"),
    "utf8",
  );
  const pinned = [...setupAction.matchAll(/uses:[ \t]*([\w.-]+\/[\w.-]+)@[0-9a-f]{40}/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    [...new Set(pinned)],
    ["actions/setup-node"],
    `.github/actions/setup/action.yml is invisible to Dependabot, so every action pinned in it is a manual bump. This now names ${[...new Set(pinned)].join(", ")} — update the comment below, and check whether Dependabot has gained support for composite actions.`,
  );
});

test("npm dependencies are grouped by what has to move together", () => {
  const block = updateFor("npm");

  /** The `patterns:` (and `exclude-patterns:`) under one group name. */
  const membersOf = (group: string): { include: string[]; exclude: string[] } => {
    const at = block.search(new RegExp(String.raw`^[ \t]*${group}:$`, "m"));
    assert.ok(at >= 0, `the npm ecosystem has no \`${group}\` group`);
    // `search` gives the offset of the group's own key, so resume after the
    // newline that ends that line — not one character later, which would leave
    // `     framework:` as the first line of the body and make the end pattern
    // match it immediately.
    const afterKey = block.indexOf("\n", at);
    assert.ok(afterKey > 0, `the \`${group}\` group key has no body`);
    // The group body ends at the next key indented no further than the group's
    // own. An indentation-blind end pattern matches `patterns:` — the group's
    // first child — immediately, which silently yields an empty body.
    const groupIndent = new RegExp(`^[ \\t]*${group}:$`, "m").exec(block)![0].length - group.length - 1;
    const rest = block.slice(afterKey + 1);
    const end = rest.search(
      new RegExp(
        String.raw`^(?:[ ]{0,${groupIndent}}\S|[ \t]*$)`,
        "m",
      ),
    );
    const body = end < 0 ? rest : rest.slice(0, end);
    const lines = body.split("\n");
    const section = (key: string) => {
      const start = lines.findIndex((line) => new RegExp(String.raw`^[ \t]*${key}:$`).test(line));
      if (start < 0) return [];
      const collected: string[] = [];
      for (const line of lines.slice(start + 1)) {
        const item = /^[ \t]*-[ \t]*"?([^"\n]+?)"?[ \t]*$/.exec(line);
        if (!item) break;
        collected.push(item[1]);
      }
      return collected;
    };
    return { include: section("patterns"), exclude: section("exclude-patterns") };
  };

  // Framework: a `next` bump that lands without its React peers is a broken
  // tree, and React's own bump without Next is the same.
  assert.deepEqual(membersOf("framework").include, ["next", "react", "react-dom"]);

  // Deploy: `@opennextjs/cloudflare` gates on the wrangler it is built against,
  // so the mismatch fails inside opennext's own check rather than ours.
  assert.deepEqual(membersOf("deploy").include, ["wrangler", "@opennextjs/cloudflare"]);

  // Payments: alone, because it is the only group whose members are allowed to
  // move without the rest of the release moving with them.
  assert.deepEqual(membersOf("payments").include, ["stripe"]);

  // Catch-all: everything else, with the named groups excluded. Without the
  // exclusions the specific groups are pointless — Dependabot prefers the
  // catch-all and the grouping silently stops happening.
  const devTooling = membersOf("dev-tooling");
  assert.deepEqual(devTooling.include, ["*"]);
  assert.deepEqual(devTooling.exclude, [
    "next",
    "react",
    "react-dom",
    "wrangler",
    "@opennextjs/cloudflare",
    "stripe",
  ]);
});

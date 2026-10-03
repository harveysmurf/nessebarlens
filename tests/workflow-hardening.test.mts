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

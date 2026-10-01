/**
 * The docs name `npm run <script>` as the way to do things, and nothing checked
 * that those scripts exist. DEVELOPMENT.md pointed `npm test` at
 * `tests/fulfillment.test.mts` -- the only test file it had been written next to
 * -- while `npm test` runs the whole glob, and told readers CI ran "lint and
 * test" when it also typechecks and gates coverage. Each of those was true when
 * written and false within a few commits, which is the failure mode: prose
 * nobody re-reads against the repo it describes.
 *
 * A doc that names a script the reader cannot run is worse than one that names
 * none, so the names are pinned here. Same shape as node-version-pin.test.mts --
 * a value duplicated in N places is only safe while a test holds the copies.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};

const DOCS = ["README.md", "DEVELOPMENT.md"].map((name) => ({
  name,
  text: fs.readFileSync(path.join(root, name), "utf8"),
}));

/** `npm run foo` and `npm run foo -- --apply`, but not `npm run` on its own. */
const NPM_RUN = /npm run ([a-z0-9:_-]+)/g;

/**
 * `npm run <script>` inside a fenced block or inline code is an instruction we
 * want checked. Prose mentions of the same shape are rare enough that accepting
 * a false positive here just means the name really does exist -- so no attempt
 * is made to tell the two apart.
 */
function scriptNamesIn(text: string): Set<string> {
  return new Set([...text.matchAll(NPM_RUN)].map((m) => m[1]));
}

for (const { name, text } of DOCS) {
  test(`${name} only names npm scripts that exist`, (t) => {
    const named = [...scriptNamesIn(text)];
    assert.ok(named.length > 0, `${name} names no npm scripts -- the glob went stale`);
    for (const script of named) {
      assert.ok(
        script in scripts,
        `${name} says \`npm run ${script}\`, which package.json does not define ` +
          `(defined: ${Object.keys(scripts).sort().join(", ")})`,
      );
    }
    t.diagnostic(`${named.length} script names checked: ${named.sort().join(", ")}`);
  });
}

test("the docs do not claim CI runs less than it does", () => {
  // DEVELOPMENT.md's CI table summarises ci.yml. If ci.yml grows a step, the
  // table has to grow with it -- the stale version of this row is what made a
  // green PR check look weaker than it was.
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const runSteps = [...ci.matchAll(/^\s+- name: (?:Run )?(\w[\w -]*)$/gm)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((s) => s !== "checkout" && s !== "setup node" && s !== "install");

  const row = DOCS.find((d) => d.name === "DEVELOPMENT.md")!.text
    .split("\n")
    .find((l) => l.includes("ci.yml") && l.includes("|"));
  assert.ok(row, "DEVELOPMENT.md has no ci.yml row in the CI table");

  for (const step of runSteps) {
    assert.ok(
      row.toLowerCase().includes(step),
      `ci.yml runs a "${step}" step that DEVELOPMENT.md's CI table does not mention: ${row.trim()}`,
    );
  }
});
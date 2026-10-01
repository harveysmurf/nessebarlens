/**
 * The node version is written down in three places -- .nvmrc, package.json
 * `engines`, and the setup-node step that every workflow reaches through the
 * shared composite action -- and nothing kept them in agreement. CI floated on
 * "24" while the local pin was 24.21.0, so a developer on 24.10 and CI on
 * 24.21 were both "the pinned version" by their own lights. That is how a
 * green local suite and a red CI suite coexist: 24.10 fails
 * tests/routes.test.mts on a loader change.
 *
 * The invariant is that .nvmrc and engines agree, that no workflow or
 * composite action inlines a literal `node-version`, and that the shared
 * setup action pins via `node-version-file: .nvmrc`. Same shape as
 * single-source-grammar.test.mts: a value duplicated in N places is only safe
 * while a test holds the copies to the same value.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

/** The oldest 24.x that runs the suite green; 24.10 fails the route tests. */
const KNOWN_GOOD_FLOOR = "24.21.0";

type Version = { major: number; minor: number; patch: number };

function parseVersion(raw: string): Version {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(raw.trim());
  assert.ok(m, `not a node version: ${JSON.stringify(raw)}`);
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8");
const pinned = parseVersion(nvmrc);

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as { engines?: { node?: string } };
const engines = pkg.engines?.node ?? "";

/**
 * `engines.node` is deliberately narrow: this project only supports one
 * form, so parse that form and fail loudly on anything else rather than
 * silently under-approximating the constraint.
 */
function satisfies(enginesRange: string, v: Version): boolean {
  const clauses = enginesRange.trim().split(/\s+/);
  for (const clause of clauses) {
    if (clause.startsWith(">=")) {
      if (compare(v, parseVersion(clause.slice(2))) < 0) return false;
    } else if (clause.startsWith("<")) {
      if (compare(v, parseVersion(clause.slice(1))) >= 0) return false;
    } else {
      assert.fail(
        `unsupported engines.node clause ${JSON.stringify(clause)} in ${JSON.stringify(enginesRange)}; ` +
          "extend satisfies() deliberately if the constraint genuinely needs a new form",
      );
    }
  }
  return true;
}

test(".nvmrc is the exact version the suite is verified on", () => {
  assert.ok(
    compare(pinned, parseVersion(KNOWN_GOOD_FLOOR)) >= 0,
    `.nvmrc is ${nvmrc.trim()}, but ${KNOWN_GOOD_FLOOR} is the oldest 24.x where tests/routes.test.mts passes`,
  );
});

test("engines.node admits the pinned version and refuses the ones that break", () => {
  assert.ok(
    satisfies(engines, pinned),
    `engines.node (${engines}) rejects the version .nvmrc pins (${nvmrc.trim()})`,
  );
  // 24.10 is not hypothetical: it is what the drifting CI setup resolved to.
  assert.equal(
    satisfies(engines, { major: 24, minor: 10, patch: 0 }),
    false,
    `engines.node (${engines}) admits 24.10.0, which fails tests/routes.test.mts`,
  );
});

function collectYaml(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  function walk(current: string) {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        out.push({ rel: path.relative(root, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  }
  walk(dir);
  return out;
}

const githubYamls = [
  ...collectYaml(path.join(root, ".github", "workflows")),
  ...collectYaml(path.join(root, ".github", "actions")),
];

test("no workflow or composite action inlines a literal node-version", (t) => {
  for (const { rel, text } of githubYamls) {
    const literals = [...text.matchAll(/^\s*node-version:\s*(.+)$/gm)].map((m) =>
      m[1].trim(),
    );
    assert.deepEqual(
      literals,
      [],
      `${rel} inlines node-version ${JSON.stringify(literals)}; use node-version-file: .nvmrc in the shared setup action instead`,
    );
  }
  assert.ok(githubYamls.length > 0, "no .github yml files found -- the glob went stale");
  t.diagnostic(`${githubYamls.length} .github yml files checked for literal node-version`);
});

test("the shared setup action pins Node via node-version-file: .nvmrc", () => {
  const setup = path.join(root, ".github", "actions", "setup", "action.yml");
  assert.ok(fs.existsSync(setup), "missing .github/actions/setup/action.yml");
  const text = fs.readFileSync(setup, "utf8");
  assert.match(
    text,
    /node-version-file:\s*\.nvmrc/,
    "setup action must pin via node-version-file: .nvmrc so it tracks the local pin",
  );
});

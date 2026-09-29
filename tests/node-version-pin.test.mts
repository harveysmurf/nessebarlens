/**
 * The node version is written down in three places -- .nvmrc, package.json
 * `engines`, and the `node-version:` of every workflow's setup-node step --
 * and nothing kept them in agreement. CI floated on "24" while the local pin
 * was 24.21.0, so a developer on 24.10 and CI on 24.21 were both "the pinned
 * version" by their own lights. That is how a green local suite and a red CI
 * suite coexist: 24.10 fails tests/routes.test.mts on a loader change.
 *
 * The invariant is that the three say the same thing, and that the agreed
 * version is new enough for the route tests. Same shape as
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

const workflowDir = path.join(root, ".github", "workflows");

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(workflowDir, name), "utf8") }));

test("every workflow pins setup-node to exactly the .nvmrc version", (t) => {
  const pinnedLine = `node-version: "${nvmrc.trim()}"`;
  for (const { name, text } of workflows) {
    const steps = [...text.matchAll(/node-version:\s*"?([^"\n]+)"?/g)].map((m) => m[1].trim());
    assert.ok(steps.length > 0, `${name} has no setup-node step to pin`);
    for (const step of steps) {
      assert.equal(
        step,
        nvmrc.trim(),
        `${name} sets setup-node to ${JSON.stringify(step)}, which floats independently of .nvmrc (${nvmrc.trim()})`,
      );
    }
  }
  assert.ok(workflows.length > 0, "no workflows found -- the glob went stale");
  t.diagnostic(`${workflows.length} workflows checked; expected literal: ${pinnedLine}`);
});

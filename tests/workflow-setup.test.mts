/**
 * Issue #120: every workflow reached checkout / setup-node / npm ci through
 * its own copy of the same three steps, so a pin or flag change had to be
 * applied by hand in four files. The shared composite action is the single
 * setup path; this guard fails if a workflow grows an inline copy again, or
 * if production stops calling the full CI suite before deploy.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");
const setupAction = "./.github/actions/setup";

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowDir, name), "utf8"),
  }));

test("no workflow inlines actions/checkout, actions/setup-node, or bare npm ci", () => {
  for (const { name, text } of workflows) {
    assert.doesNotMatch(
      text,
      /uses:\s*actions\/checkout@/,
      `${name} inlines actions/checkout; use ${setupAction}`,
    );
    assert.doesNotMatch(
      text,
      /uses:\s*actions\/setup-node@/,
      `${name} inlines actions/setup-node; use ${setupAction}`,
    );
    assert.doesNotMatch(
      text,
      /^\s*run:\s*npm ci\b/m,
      `${name} runs bare npm ci; use ${setupAction} (with install-args if needed)`,
    );
  }
  assert.ok(workflows.length > 0, "no workflows found -- the glob went stale");
});

test("every workflow uses the shared setup composite action", () => {
  for (const { name, text } of workflows) {
    assert.match(
      text,
      /uses:\s*\.\/\.github\/actions\/setup\b/,
      `${name} never calls ${setupAction}`,
    );
  }
});

test("ci.yml has no push trigger -- prod.yml calls it and gates deploy on it", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");
  assert.ok(ci, "ci.yml is gone");

  // Slice past the `on:` line itself, then stop at the next top-level key:
  // splitting from the `on:` line would split on it and yield an empty block.
  const onIdx = ci.text.search(/^on:[ \t]*$/m);
  assert.ok(onIdx >= 0, "ci.yml has no top-level on: block");
  const onBlock = ci.text.slice(onIdx).split(/\n\S/)[0];
  assert.doesNotMatch(
    onBlock,
    /^\s{2}push:/m,
    "ci.yml triggers on push, so every main merge runs the suite twice: once from this trigger and once from prod.yml's checks job",
  );
});

test("prod.yml deploy needs a job that calls ci.yml", () => {
  const prod = workflows.find((w) => w.name === "prod.yml");
  assert.ok(prod, "prod.yml is gone");

  const jobsIdx = prod.text.search(/^jobs:\s*$/m);
  assert.ok(jobsIdx >= 0, "prod.yml has no jobs: section");
  const jobsText = prod.text.slice(jobsIdx);

  const jobBlocks = [
    ...jobsText.matchAll(/^ {2}([a-z][\w-]*):\n((?:(?: {4}|\t).*\n|\n)*)/gm),
  ];
  assert.ok(jobBlocks.length > 0, "prod.yml has no jobs under jobs:");

  const callers = jobBlocks
    .filter(([, , body]) => /uses:\s*\.\/\.github\/workflows\/ci\.yml\b/.test(body))
    .map(([, id]) => id);
  assert.ok(
    callers.length > 0,
    "prod.yml has no job that uses ./.github/workflows/ci.yml",
  );

  const deploy = jobBlocks.find(([, id]) => id === "deploy");
  assert.ok(deploy, "prod.yml has no deploy job");
  const needsMatch = deploy[2].match(/^\s*needs:\s*(.+)$/m);
  assert.ok(needsMatch, "prod.yml deploy job has no needs:");
  const needed = needsMatch[1].trim();
  const neededIds = needed.startsWith("[")
    ? needed
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
    : [needed];
  assert.ok(
    callers.some((id) => neededIds.includes(id)),
    `prod.yml deploy needs ${JSON.stringify(neededIds)}, but the ci.yml caller(s) are ${JSON.stringify(callers)}`,
  );
});

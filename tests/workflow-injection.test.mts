/**
 * Issue #112: `preview.yml` interpolated `github.head_ref` straight into a
 * `run:` block. That expression is the PR author's branch name, so the
 * workflow handed it to bash as source on a job holding Cloudflare deploy
 * credentials — a branch named `a"; curl … ; #` executes in a job that can
 * deploy.
 *
 * `prod.yml` already passed its commit message through `env:`; the preview
 * workflow did not. The fix is the `env:` hop in both preview jobs, and this
 * guard is what keeps it from regressing: a behavioural test cannot see this,
 * because a unit test would have to shell out the way an attacker would.
 *
 * Deliberately narrow. Not every `${{ }}` in a `run:` block is a hole — a
 * commit SHA is hex, a PR number is an integer — so the guard names the
 * attacker-controlled expressions rather than banning interpolation outright.
 * Failing on all of them would train the next reader to disable it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");
const actionDir = path.join(root, ".github", "actions");

// Every one of these is text an untrusted author chooses, not a platform
// value: a branch name, a PR title, a commit message.
const untrusted = [
  "github\\.head_ref",
  "github\\.event\\.pull_request\\.title",
  "github\\.event\\.pull_request\\.body",
  "github\\.event\\.pull_request\\.head\\.ref",
  "github\\.event\\.pull_request\\.head\\.label",
  "github\\.event\\.head_commit\\.message",
  "github\\.event\\.commits\\[[^\\]]*\\]\\.message",
];

const files = [
  ...fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => path.join(workflowDir, name)),
  ...fs
    .readdirSync(actionDir)
    .filter((name) =>
      fs.statSync(path.join(actionDir, name)).isDirectory(),
    )
    .flatMap((dir) =>
      fs
        .readdirSync(path.join(actionDir, dir))
        .filter((name) => name.endsWith(".yml"))
        .map((name) => path.join(actionDir, dir, name)),
    ),
];

/**
 * Yields `[lineNumber, line]` for every line that is inside a `run:` block:
 * the inline form plus the block scalar (`run: |`), up to the next key of the
 * same step. A line-keyed scan rather than a real YAML parse because these
 * files use anchors-free plain YAML and a parser would be a heavier dependency
 * than the invariant warrants.
 */
function* runBlockLines(text: string): Generator<[number, string]> {
  const lines = text.split("\n");
  let inside = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*run:\s*\|/.test(line)) {
      inside = true;
      continue;
    }
    if (/^\s*run:\s*\S/.test(line)) {
      inside = false;
      yield [i + 1, line];
      continue;
    }
    if (inside) {
      // A new step key at the step's own indentation closes the block.
      if (/^\s*-\s+\w[\w-]*:/.test(line) || /^\s{4}\w[\w-]*:/.test(line)) {
        inside = false;
        continue;
      }
      yield [i + 1, line];
    }
  }
}

test("no run: block evaluates an author-controlled expression", () => {
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const label = path.relative(root, file);
    for (const [line, content] of runBlockLines(text)) {
      const match = untrusted.find((pattern) =>
        new RegExp(`\\$\\{\\{\\s*${pattern}`).test(content),
      );
      assert.equal(
        match,
        undefined,
        `${label}:${line} evaluates ${match ?? ""} inside a run: block — pass it through \`env:\` and let the shell quote it`,
      );
    }
  }
});

test("the preview branch-name steps read github.head_ref from env, not from the shell", () => {
  // The invariant above can be satisfied by deleting the sanitize step. Pin
  // the mechanism too, so the guard cannot be met by removing the feature that
  // needs guarding.
  const preview = fs.readFileSync(path.join(workflowDir, "preview.yml"), "utf8");
  const sanitizeSteps = preview.match(
    /- name: Sanitize branch name\n(?: {8}.*\n)+/g,
  );
  assert.equal(sanitizeSteps?.length, 2, "both preview jobs sanitize the branch name");
  for (const step of sanitizeSteps ?? []) {
    assert.match(
      step,
      /HEAD_REF: \$\{\{ github\.head_ref \}\}/,
      "github.head_ref must arrive through env: so bash quotes it",
    );
  }
});
/**
 * Every `run:` block parses as bash.
 *
 * This catches the class of CI failure that lands as an unrunnable deploy step
 * on a workflow holding deploy credentials, and it costs one `bash -n` per
 * block with nothing executed.
 *
 * Deliberately narrow about what it claims. `bash -n` finds *syntax* errors
 * only. It does NOT catch a line that parses but does the wrong thing — on #172
 * a `PR_NUMBER: 172` line written into the script instead of `env:` parsed
 * perfectly and failed at runtime with `PR_NUMBER:: command not found`. The
 * test for that is the review that reads the diff, not this file; claiming
 * otherwise here would make a real hole look covered.
 *
 * Actions expressions are substituted with an inert token first, because
 * `${{ ... }}` is not bash syntax and bash would reject it for the wrong
 * reason.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");

/**
 * Extract every `run:` block, block-scalar or inline, with the step it belongs
 * to. Hand-rolled rather than a YAML dependency the repo does not have.
 */
function runBlocks(): { where: string; script: string }[] {
  const out: { where: string; script: string }[] = [];
  for (const name of fs.readdirSync(workflowDir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = fs.readFileSync(path.join(workflowDir, name), "utf8");
    if (!/^jobs:[ \t]*$/m.test(text)) continue;
    const jobs = text.slice(text.search(/^jobs:[ \t]*$/m));

    let job = "job";
    let step = "step";
    let inRun = false;
    let runIndent = 0;
    let buf: string[] = [];

    const flush = () => {
      if (buf.length) out.push({ where: `${name}/${job}/${step}`, script: buf.join("\n") });
      buf = [];
      inRun = false;
    };

    for (const line of jobs.split("\n")) {
      const indent = line.length - line.trimStart().length;
      const jobMatch = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
      if (jobMatch) {
        flush();
        job = jobMatch[1];
        continue;
      }
      if (/^\s*-\s*name:\s*(.+)$/.test(line)) {
        flush();
        step = /^\s*-\s*name:\s*(.+)$/.exec(line)![1].trim();
        continue;
      }
      const blockScalar = /^\s*run:\s*\|\s*$/.exec(line);
      if (blockScalar) {
        flush();
        inRun = true;
        runIndent = indent;
        continue;
      }
      const inline = /^\s*run:\s*(\S.*)$/.exec(line);
      if (inline && !inRun) {
        out.push({ where: `${name}/${job}/${step}`, script: inline[1] });
        continue;
      }
      if (inRun) {
        // The block scalar ends at the first non-blank line indented no further.
        if (line.trim() === "" || indent > runIndent) {
          buf.push(line.slice(Math.min(runIndent + 2, indent)));
        } else {
          flush();
        }
      }
    }
    flush();
  }
  return out;
}

test("every run: block parses as bash", () => {
  const blocks = runBlocks();
  // If the reader ever silently stops finding scripts, this passes vacuously.
  assert.ok(
    blocks.length >= 10,
    `only found ${blocks.length} run: blocks across the workflows; the reader is broken, so this test is not checking anything`,
  );

  for (const { where, script } of blocks) {
    const substituted = script.replace(/\$\{\{[^}]*\}\}/g, "PLACEHOLDER");
    const result = spawnSync("bash", ["-n"], { input: substituted, encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      `${where} has a run: block that is not valid bash:\n${result.stderr}\n---\n${script}`,
    );
  }
});

test("the reader sees the blocks it claims to", () => {
  // Pins the reader against a workflow losing its scripts silently: preview.yml
  // is the workflow this has bitten, and it has several multi-line steps.
  const blocks = runBlocks();
  const preview = blocks.filter((b) => b.where.startsWith("preview.yml"));
  assert.ok(
    preview.length >= 5,
    `found ${preview.length} run: blocks in preview.yml; expected at least 5`,
  );
  assert.ok(
    blocks.some((b) => b.script.includes("opennextjs-cloudflare")),
    "no run: block mentions opennextjs-cloudflare; the deploy steps vanished",
  );
});
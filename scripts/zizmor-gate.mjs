/**
 * Scoped zizmor gate: `template-injection` only, at Medium confidence and up.
 *
 * Why not a plain `zizmor` run: a default run on this repo was not green, and no
 * combination of --min-severity / --min-confidence / --persona made it green.
 * The other rules were real work that had nothing to do with #112 and must not
 * be bundled into it — measured on the tree as of 9641a8b:
 *
 *   unpinned-uses 12            excessive-permissions 11
 *   self-repository 9           artipacked 8
 *
 * They were reported here and did not gate. #165 has since cleared all four
 * classes, so the advisory set is down to the 3 Low/Informational
 * `template-injection` findings described below — but the gate deliberately
 * stays scoped to that one rule rather than becoming "any finding fails". The
 * confidence floor is the part that keeps it honest; without it the sanitized
 * interpolations alone would make the job permanently red on safe code, and a
 * red gate nobody can satisfy is a gate everyone learns to skip.
 *
 * Why the confidence filter and not the rule name alone: after the `env:` fix,
 * the only remaining `template-injection` findings are the sanitized
 * `steps.branch.outputs.name` interpolations. zizmor cannot trace the value
 * back through scripts/sanitize-branch-name.sh, so it rates them Low /
 * Informational. Failing on all `template-injection` would therefore be
 * permanently red on code that is already safe — the same false-red trap as
 * gating on a suite that only skips. Confidence is the axis that actually
 * separates "our hole" from "already hardened":
 *
 *   pre-fix  (9641a8b^)  2x High/High + 6x Low/Informational  -> gate fails
 *   post-fix (9641a8b)   0x >= Medium                        -> gate passes
 *
 * Both are measured, not assumed; see the commit message.
 *
 * The default persona is used deliberately. `--persona auditor` and
 * `--persona pedantic` promote the sanitized step-output findings to High
 * confidence, which would make the confidence filter gate on them again and
 * reopen the false-red this filter exists to close.
 *
 * Usage: node scripts/zizmor-gate.mjs [-- <zizmor args>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATED_RULE = "template-injection";
const GATED_CONFIDENCE = new Set(["High", "Medium"]);

/* GitHub accepts both extensions, so the gate must too: a future .yaml
   workflow would otherwise be skipped by the job meant to cover it. */
const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];
const isWorkflow = (name) => WORKFLOW_EXTENSIONS.some((ext) => name.endsWith(ext));

function workflowFiles() {
  const dirs = [
    join(root, ".github", "workflows"),
    join(root, ".github", "actions"),
  ];
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (isWorkflow(entry) && statSync(full).isFile()) {
        files.push(full);
      } else if (statSync(full).isDirectory()) {
        for (const nested of readdirSync(full)) {
          if (isWorkflow(nested)) files.push(join(full, nested));
        }
      }
    }
  }
  return files.sort();
}

function parse(raw) {
  try {
    const findings = JSON.parse(raw);
    if (!Array.isArray(findings)) {
      throw new Error("expected a JSON array of findings");
    }
    return findings;
  } catch (error) {
    throw new Error(`could not parse zizmor JSON output: ${error.message}`);
  }
}

function label(finding) {
  const location = finding.locations?.[0];
  const file =
    location?.symbolic?.key?.Local?.verbatim_path ??
    location?.key?.Local?.verbatim_path ??
    "unknown";
  const line = location?.concrete?.location?.start_point?.row;
  return line ? `${file}:${line}` : file;
}

export function classify(findings) {
  const gating = [];
  const advisory = new Map();
  for (const finding of findings) {
    const confidence = finding.determinations?.confidence;
    const severity = finding.determinations?.severity ?? "Unknown";
    // Fail closed on a missing confidence: a shape we cannot classify is a
    // shape we must not wave through. `GATED_CONFIDENCE.has(undefined)` is
    // false, so the rule name has to be checked explicitly.
    if (
      finding.ident === GATED_RULE &&
      (confidence === undefined || GATED_CONFIDENCE.has(confidence))
    ) {
      gating.push({ label: label(finding), confidence, severity });
      continue;
    }
    const key = `${finding.ident} (${confidence}/${severity})`;
    advisory.set(key, (advisory.get(key) ?? 0) + 1);
  }
  return { gating, advisory };
}

function main() {
  const passthrough = process.argv.slice(2);
  const args = [
    "--format",
    "json",
    // Pinned explicitly rather than left to zizmor's default. `auditor` and
    // `pedantic` promote the sanitized `steps.branch.outputs.name` findings to
    // High confidence, which puts them back in the gate and makes it red on
    // code that is already safe. Spelling the persona out means the next
    // person to change it has to delete this line, which is a reviewable act,
    // rather than flipping a default nobody sees.
    "--persona",
    "regular",
    ...(passthrough.length ? passthrough : workflowFiles().map(relative.bind(null, root))),
  ];
  const run = spawnSync("zizmor", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (run.error) {
    console.error(`::error::could not run zizmor: ${run.error.message}`);
    return 4;
  }
  // zizmor exits non-zero whenever it reports anything, which is expected here
  // because the advisory rules are permanently unfixed. A parse failure is the
  // only outcome that means the audit itself did not happen.
  if (!run.stdout.trim()) {
    console.error(
      `::error::zizmor produced no findings on stdout (exit ${run.status}):\n${run.stderr}`,
    );
    return 4;
  }

  const { gating, advisory } = classify(parse(run.stdout));

  if (advisory.size > 0) {
    console.log("Advisory findings — reported, not gating:");
    for (const [key, count] of [...advisory].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}\t${key}`);
    }
    console.log(
      "\nThese are reported, not gated, and deliberately so. Fixing a rule\n" +
        "here would mix an unrelated change into a security gate; a rule that\n" +
        "is allowed to fail the build is not a rule, it is a suggestion. The\n" +
        "advisory rules that were real work (#165) are fixed at the source and\n" +
        "carry their own tests; what is left is confidence-floored code that is\n" +
        "already hardened.",
    );
  }

  if (gating.length === 0) {
    console.log(
      `\nNo ${GATED_RULE} findings at Medium confidence or above — gate passes.`,
    );
    return 0;
  }

  console.error(
    `\n::error::${gating.length} ${GATED_RULE} finding(s) at Medium confidence or above:`,
  );
  for (const item of gating) {
    console.error(`  ${item.label}\t${item.confidence}/${item.severity}`);
  }
  console.error(
    "\nAn attacker-controlled expression (branch name, PR title/body, commit\n" +
      "message) is being evaluated as workflow-level shell source. Pass it\n" +
      "through `env:` and let the shell quote it.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = main();
  if (result !== 0) process.exitCode = result;
}

/**
 * Zero-dependency coverage gate.
 *
 * Runs the suite under node's built-in V8 coverage, then enforces floors over
 * the gated files: src/lib plus the five src/app/api route handlers. The page
 * tree and components/ are React code that a DOM would be needed to measure
 * honestly, so they stay out until that is a decision worth making.
 *
 * Line numbers are trustworthy because node strips the types itself, in place:
 * there is no transpiler output between the .ts and the code V8 sees. The
 * previous ts.transpileModule loader needed a source map to say that much, and
 * still misplaced object-literal spreads — it reported executed lines as
 * uncovered, so the number it produced was not a measurement of this code.
 *
 * The floor is checked here rather than via --test-coverage-lines. Lines /
 * branches / functions are the simple mean over the gated files, not
 * a line-weighted total: that is pessimistic for big files and is therefore safe
 * to ratchet upward.
 *
 * The report's last column lists uncovered *lines* only, so a file can sit
 * below the branch floor with nothing to show for it. `--files` is the way
 * past that: the per-file table. For an exact branch line, the lcov reporter
 * does print them (BRDA records) where the summary table does not.
 *
 *   npm run coverage          # check against the floors below
 *   npm run coverage:report   # report without gating
 *   npm run coverage -- --files  # per-file, worst branch coverage first
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isGatedFile, mean, parseCoverage, testRunExitCode } from "./coverage-report.mjs";

const ROOT = path.join(import.meta.dirname, "..");

/** Ratchet: never lower these, raise them as tests land. */
const FLOOR = { lines: 99.95, branches: 99.9, functions: 100 };

// The test runner takes the glob itself, but only a shell expands it, so pass
// the file list explicitly.
const testFiles = readdirSync(path.join(ROOT, "tests"))
  .filter((name) => name.endsWith(".test.mts"))
  .sort()
  .map((name) => `tests/${name}`);

// A second reporter writes lcov to a file, next to the usual stdout report. The
// table's last column lists uncovered lines only; lcov's BRDA records are the
// only place a never-taken branch on an otherwise executed line shows up.
const lcovDir = mkdtempSync(path.join(os.tmpdir(), "coverage-"));
const lcovFile = path.join(lcovDir, "lcov.info");

const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-coverage",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovFile}`,
    "--import",
    "./tests/register.mjs",
    "--test",
    ...testFiles,
  ],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

let lcov = "";
try {
  lcov = readFileSync(lcovFile, "utf8");
} catch {
  // Best effort: the gate itself does not depend on it.
}
rmSync(lcovDir, { recursive: true, force: true });

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
// A failing test still emits a full coverage report, so the floors below can be
// met on a red suite. The suite's own verdict decides before the floors do.
const testExit = testRunExitCode(result);
if (testExit !== null) {
  if (result.error) process.stderr.write(String(result.error));
  process.stderr.write("coverage.mjs: the test run failed, so the floors were not checked\n");
  process.stderr.write(output.slice(-4000));
  process.exit(testExit);
}

const rows = parseCoverage(output);
if (rows.length === 0) {
  process.stderr.write("coverage.mjs: no file rows in the coverage report\n");
  process.stderr.write(output.slice(-4000));
  process.exit(1);
}

const gated = rows.filter((row) => isGatedFile(row.file));
const tests = rows.filter((row) => /(^|\/)tests\//.test(row.file));
if (gated.length === 0) {
  process.stderr.write(
    `coverage.mjs: parsed ${rows.length} rows but none under src/lib or src/app/api\n`,
  );
  process.exit(1);
}

const actual = {
  lines: mean(gated, "lines"),
  branches: mean(gated, "branches"),
  functions: mean(gated, "functions"),
};

console.log(`gated: src/lib + src/app/api (${gated.length} files, mean over files)`);
for (const name of ["lines", "branches", "functions"]) {
  console.log(
    `  ${name.padEnd(10)} ${actual[name].toFixed(2).padStart(6)}%  floor ${FLOOR[name]}%`,
  );
}
if (tests.length > 0) {
  console.log(`  (test files are measured too: ${mean(tests, "lines").toFixed(2)}% lines)`);
}

if (process.argv.includes("--files")) {
  // Per-file, worst branch coverage first: this is the working list of gaps.
  for (const row of [...gated].sort((a, b) => a.branches - b.branches)) {
    console.log(
      `${row.branches.toFixed(2).padStart(6)}% br ${row.lines.toFixed(2).padStart(6)}% ln  ` +
        `${row.file.replace(`${ROOT}/`, "")}  ${row.uncovered}`,
    );
  }
  process.exit(0);
}

if (process.argv.includes("--print")) process.exit(0);

const failures = [];
for (const name of ["lines", "branches", "functions"]) {
  if (actual[name] < FLOOR[name]) {
    failures.push(`${name} ${actual[name].toFixed(2)}% < ${FLOOR[name]}%`);
  }
}
if (failures.length > 0) {
  console.error(`\ncoverage floor not met: ${failures.join(", ")}`);
  console.error("files below the floor:");
  for (const row of [...gated].sort((a, b) => a.lines - b.lines)) {
    if (row.lines < FLOOR.lines) {
      console.error(`  ${row.lines.toFixed(2).padStart(6)}%  ${row.file}  ${row.uncovered}`);
    }
  }
  const gaps = branchGaps(lcov).filter((gap) => isGatedFile(gap.file));
  if (gaps.length > 0) {
    console.error("branches never taken, by file (line:branch-index):");
    for (const { file, taken, total, lines } of gaps) {
      console.error(`  ${file}  ${total - taken}/${total} untaken  at ${lines.join(", ")}`);
    }
  }
  process.exit(1);
}
console.log("\ncoverage floors met");

/** Files with branches that never ran, from lcov BRDA records. */
function branchGaps(text) {
  const gaps = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { file: path.relative(ROOT, line.slice(3)), taken: 0, total: 0, lines: [] };
    } else if (line.startsWith("BRDA:") && current) {
      const [lineNo, , branch, count] = line.slice(5).split(",");
      current.total += 1;
      if (count === "-" || Number(count) === 0) current.lines.push(`${lineNo}:${branch}`);
      else current.taken += 1;
    } else if (line === "end_of_record" && current) {
      if (current.taken < current.total) gaps.push(current);
      current = null;
    }
  }
  return gaps.sort((a, b) => a.taken / a.total - b.taken / b.total);
}

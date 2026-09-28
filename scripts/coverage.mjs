/**
 * Zero-dependency coverage gate.
 *
 * Runs the suite under node's built-in V8 coverage, then enforces floors over
 * src/lib only. app/ and components/ are Next.js route and React code that no
 * test imports yet, so including them would report a meaningless number.
 *
 * Line numbers are only trustworthy because tests/ts-loader.mjs emits an
 * inline source map: without it the reporter attributes V8 positions to the
 * transpiled output and executed code reads as uncovered (it reported
 * prodigi-order.ts at 69% when it is at 98%).
 *
 * Node 20 has no --test-coverage-lines flag, so the floor is checked here
 * instead. Lines/branches/functions are the simple mean over src/lib files,
 * not a line-weighted total: that is pessimistic for big files and is
 * therefore safe to ratchet upward.
 *
 *   node scripts/coverage.mjs            # check against the floors below
 *   node scripts/coverage.mjs --print    # report without gating
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.join(import.meta.dirname, "..");

/** Ratchet: never lower these, raise them as tests land. */
const FLOOR = { lines: 94, branches: 93, functions: 94 };

const pct = (value) => Number.parseFloat(value);

// Node's test runner takes the glob itself, but only the shell expands it, so
// pass the file list explicitly.
const testFiles = readdirSync(path.join(ROOT, "tests"))
  .filter((name) => name.endsWith(".test.mts"))
  .sort()
  .map((name) => `tests/${name}`);

const result = spawnSync(
  process.execPath,
  ["--experimental-test-coverage", "--import", "./tests/register.mjs", "--test", ...testFiles],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0 && !output.includes("# start of coverage report")) {
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

const rows = [];
for (const line of output.split("\n")) {
  if (!line.startsWith("# src/") && !line.startsWith("# tests/")) continue;
  const [file, lines, branches, functions] = line
    .replace(/^#\s*/, "")
    .split("|")
    .map((part) => part.trim());
  rows.push({
    file,
    lines: pct(lines),
    branches: pct(branches),
    functions: pct(functions),
    uncovered: line.split("|").slice(4).join("|").trim(),
  });
}

const mean = (key, subset) =>
  subset.reduce((sum, row) => sum + row[key], 0) / (subset.length || 1);

const lib = rows.filter((row) => row.file.startsWith("src/lib/"));
const tests = rows.filter((row) => row.file.startsWith("tests/"));
if (lib.length === 0) {
  process.stderr.write("coverage.mjs: no src/lib rows in the coverage report\n");
  process.exit(1);
}

const scope = mean("lines", lib);
const scopeBranches = mean("branches", lib);
const scopeFunctions = mean("functions", lib);

const pad = (value) => String(value).padStart(6);
console.log(`src/lib (${lib.length} files, mean over files)`);
for (const [name, actual, floor] of [
  ["lines", scope, FLOOR.lines],
  ["branches", scopeBranches, FLOOR.branches],
  ["functions", scopeFunctions, FLOOR.functions],
]) {
  console.log(`  ${name.padEnd(10)} ${pad(actual.toFixed(2))}%  floor ${floor}%`);
}
if (tests.length > 0) {
  console.log(
    `  (test files are measured too: ${mean("lines", tests).toFixed(2)}% lines)`,
  );
}

if (process.argv.includes("--print")) process.exit(0);

const failures = [];
if (scope < FLOOR.lines) failures.push(`lines ${scope.toFixed(2)}% < ${FLOOR.lines}%`);
if (scopeBranches < FLOOR.branches) {
  failures.push(`branches ${scopeBranches.toFixed(2)}% < ${FLOOR.branches}%`);
}
if (scopeFunctions < FLOOR.functions) {
  failures.push(`functions ${scopeFunctions.toFixed(2)}% < ${FLOOR.functions}%`);
}
if (failures.length > 0) {
  console.error(`\ncoverage floor not met: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ncoverage floors met");

/**
 * Zero-dependency coverage gate.
 *
 * Runs the suite under node's built-in V8 coverage, then enforces floors over
 * src/lib only. app/ and components/ are Next.js route and React code that no
 * test imports yet, so including them would report a number nobody can act on.
 *
 * Line numbers are trustworthy because node strips the types itself, in place:
 * there is no transpiler output between the .ts and the code V8 sees. The
 * previous ts.transpileModule loader needed a source map to say that much, and
 * still misplaced object-literal spreads — it reported executed lines as
 * uncovered, so the number it produced was not a measurement of this code.
 *
 * The floor is checked here rather than via --test-coverage-lines. Lines /
 * branches / functions are the simple mean over src/lib files, not
 * a line-weighted total: that is pessimistic for big files and is therefore safe
 * to ratchet upward.
 *
 *   npm run coverage          # check against the floors below
 *   npm run coverage:report   # report without gating
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isLibFile, mean, parseCoverage } from "./coverage-report.mjs";

const ROOT = path.join(import.meta.dirname, "..");

/** Ratchet: never lower these, raise them as tests land. */
const FLOOR = { lines: 99.9, branches: 99.8, functions: 100 };

// The test runner takes the glob itself, but only a shell expands it, so pass
// the file list explicitly.
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
const rows = parseCoverage(output);
if (rows.length === 0) {
  process.stderr.write("coverage.mjs: no file rows in the coverage report\n");
  process.stderr.write(output.slice(-4000));
  process.exit(1);
}

const lib = rows.filter((row) => isLibFile(row.file));
const tests = rows.filter((row) => /(^|\/)tests\//.test(row.file));
if (lib.length === 0) {
  process.stderr.write(
    `coverage.mjs: parsed ${rows.length} rows but none under src/lib\n`,
  );
  process.exit(1);
}

const actual = {
  lines: mean(lib, "lines"),
  branches: mean(lib, "branches"),
  functions: mean(lib, "functions"),
};

console.log(`src/lib (${lib.length} files, mean over files)`);
for (const name of ["lines", "branches", "functions"]) {
  console.log(
    `  ${name.padEnd(10)} ${actual[name].toFixed(2).padStart(6)}%  floor ${FLOOR[name]}%`,
  );
}
if (tests.length > 0) {
  console.log(`  (test files are measured too: ${mean(tests, "lines").toFixed(2)}% lines)`);
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
  for (const row of [...lib].sort((a, b) => a.lines - b.lines)) {
    if (row.lines < FLOOR.lines) {
      console.error(`  ${row.lines.toFixed(2).padStart(6)}%  ${row.file}  ${row.uncovered}`);
    }
  }
  process.exit(1);
}
console.log("\ncoverage floors met");

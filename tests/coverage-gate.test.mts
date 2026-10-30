/**
 * The coverage gate's decisions.
 *
 * `scripts/coverage.mjs` is the runner: it spawns the suite, reads node's
 * coverage report and prints. The decisions — is the measured coverage over
 * the floors, is every script the gate claims to cover actually loaded, is
 * every script accounted for — live in `scripts/coverage-gate.mjs`, a module
 * with no side effects, and this file is what makes those decisions testable.
 *
 * The split exists because a runner's exit code cannot show that the gate's
 * decisions work: "the suite is green" is not evidence about a *failing* gate,
 * because the suite is what the gate runs. A gate whose decisions have never
 * been run against a report that ought to fail is a gate nobody can trust to
 * fail.
 *
 * Two kinds of fixture are used, and the difference matters:
 *
 *   - the captured excerpt below is node's own output, taken from a real run
 *     of this repo's suite. It pins the *shape* the parser has to read and the
 *     numbers the gate has to survive.
 *   - the rows the assertions build are synthetic, because the assertions are
 *     about arithmetic. A captured number would make the test fail when the
 *     floor is ratcheted upward, which is the floor doing its job.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SCRIPT_ALLOW_LIST,
  SCRIPT_FLOOR,
  SRC_FLOOR,
  gate,
  isGatedScript,
} from "../scripts/coverage-gate.mjs";
import { parseCoverage } from "../scripts/coverage-report.mjs";

const ROOT = path.join(import.meta.dirname, "..");

/**
 * The scripts section of node 24's report, verbatim from a run of this repo's
 * suite (`npm run coverage`, node 24.22.1, the tree layout with the reporter
 * marker). The numbers are this repo's real coverage numbers; they are here
 * so the gate is exercised against the report it will really read, not
 * against a tidy one.
 */
const CAPTURED_SCRIPTS = `
ℹ scripts                              |        |          |         |
ℹ  analytics-report.mjs                |  97.41 |    82.89 |   95.24 | 234-235 240-241 424-425 485-489 501-502
ℹ  audit-photos.mjs                    |  90.50 |    83.51 |   84.62 | 117-119 361-370 380-384 389-397 412-416 433-442
ℹ  audit-prodigi-cancellations.mjs     |  90.84 |    78.68 |   89.47 | 252-257 363-364 366-367 389-394 411-416 422-427 440-446 502-513
ℹ  build-catalog.mjs                   |  85.92 |    74.19 |   90.00 | 32 38-39 124-138 141-142
ℹ  capture-prodigi-products.mjs        |  59.43 |    92.86 |   28.57 | 95-101 106-110 119-135 137-143 153-161 164-188 192-197 238-267 274-281
ℹ  capture-stripe-fixtures.mjs         |  73.60 |    89.19 |   69.23 | 124-126 129-164 171-178
ℹ  cf-env-types.mjs                    |  80.37 |    88.89 |   25.00 | 158-164 166-174 181-184 193-214
ℹ  coverage-report.mjs                 | 100.00 |    92.11 |  100.00 |
ℹ  dependabot-settings.mjs             |  76.99 |    84.62 |   75.00 | 67-68 88-108 111-113
ℹ  derivative-image.mjs                | 100.00 |    88.24 |  100.00 |
ℹ  generate-ship-to-countries.mjs      |  71.21 |    95.00 |   84.62 | 87-94 97-119 126-132
ℹ  js-file-name.mjs                    | 100.00 |   100.00 |  100.00 |
ℹ  list-orders.mjs                     |  63.43 |    72.50 |   85.71 | 109-112 141-142 168-169 171-173 176-257 264-268
ℹ  migrate-orders-kv-to-d1.mjs         |  80.09 |    56.18 |   84.62 | 49 66-67 117-127 242-243 265-270 303-306 314-319 323 325-326 360-361 369-371 377-390 392-421 434-436
ℹ  photo-listing-check.mjs             |  77.53 |    89.66 |   84.21 | 340-365 368-374 384-442 445-454
ℹ  photo-master-attestation.mjs        |  81.23 |    82.67 |   77.78 | 135-139 162-163 177-178 181-182 209-210 213-214 277-279 320-366 369-373
ℹ  publish-photos.mjs                  |  88.22 |    72.61 |   83.52 | 249-250 763-767 772-776 784-787 812-814 819-821 879 918-920 1063-1070 1086-1087 1095-1102 1129-1138 1188 1193-1197 1219-1222 1229-1236 1247-1250 1306-1311 1365-1366 1465-1467 1499-1502 1556-1557 1577-1578 1584-1595 1632-1635 1640-1642 1660-1661 1668-1672 1677-1679 1683-1688 1699-1704 1707-1712 1724-1725 1752-1758 1780-1781 1817-1819 1832-1835 1884-1890 1903-1907 1942-1945 1985-1988 1992-1994 2004-2006 2008-2010 2015-2017 2020-2024 2036-2040 2043-2060 2077-2080 2083-2085 2117-2120 2132-2135 2156-2159 2185-2200 2203-2207
ℹ  register.mjs                        | 100.00 |   100.00 |  100.00 |
ℹ  remove-orders-kv.mjs                |  80.97 |    83.89 |   70.97 | 89-90 95-96 142 261-274 280-281 385-386 537-567 573-583 590-609 611-630 632-641 648-657
ℹ  required-checks.mjs                 |  94.19 |    63.27 |  100.00 | 158-159 162-163 187-188 191-192 245-250 292-296
ℹ  resolve-deployed-sha.mjs            |  91.33 |    75.86 |   71.43 | 156-161 163-169 172-173
ℹ  resolve-hooks.mjs                   | 100.00 |    93.33 |  100.00 |
ℹ  sql-binds.mjs                       |  94.44 |    90.00 |  100.00 | 32-33
ℹ  verify-masters.mjs                  |  86.74 |    89.13 |   81.82 | 144-148 192-196 201-205 255-266 270-279
ℹ  verify-stripe-integration.mjs       |  43.39 |    95.65 |   36.36 | 131-140 142-144 147-161 163-166 169-176 186-337 344-348
ℹ  zero-ref-exports.mjs                |  98.17 |    96.00 |   96.15 | 169-172 326-327
ℹ  zizmor-gate.mjs                     |  46.43 |    90.00 |   33.33 | 56-76 78-88 122-191 194-196
`;

/** One synthetic row, in the shape `parseCoverage` produces. */
function row(
  file: string,
  lines: number,
  branches: number,
  functions: number,
): { file: string; lines: number; branches: number; functions: number; uncovered: string } {
  return { file, lines, branches, functions, uncovered: "" };
}

/** The scripts in this repo, as the runner sees them. */
function scriptsOnDisk(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => `scripts/${name}`);
}

/** A report with one src file and one script, both fully covered. */
const GREEN_ROWS = [
  row("src/domain/pricing/sku-map.ts", 100, 100, 100),
  row("scripts/list-orders.mjs", 100, 100, 100),
];

test("a report that meets both floors has no failures", () => {
  const verdict = gate({
    rows: GREEN_ROWS,
    scriptFiles: ["scripts/list-orders.mjs"],
    allowList: {},
  });
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.actual.src.lines, 100);
  assert.equal(verdict.actual.scripts.lines, 100);
});

test("a src file below the floor fails, and the failure names the metric", () => {
  const verdict = gate({
    rows: [row("src/domain/pricing/sku-map.ts", 98, 100, 100), GREEN_ROWS[1]!],
    scriptFiles: ["scripts/list-orders.mjs"],
    allowList: {},
  });
  assert.deepEqual(verdict.failures, ["src lines 98.00% < 99.95%"]);
});

test("a script below the floor fails, against the scripts floor and not the src one", () => {
  const verdict = gate({
    rows: [GREEN_ROWS[0]!, row("scripts/list-orders.mjs", 10, 100, 100)],
    scriptFiles: ["scripts/list-orders.mjs"],
    allowList: {},
  });
  assert.deepEqual(verdict.failures, ["scripts lines 10.00% < 83%"]);
});

test("a gated script that the report does not carry fails the gate", () => {
  // The report lists loaded modules only. A script no test imports is simply
  // absent from it, so without this check the gate would measure one file
  // fewer and stay green — the coverage-gate blind spot.
  const verdict = gate({
    rows: GREEN_ROWS,
    scriptFiles: ["scripts/list-orders.mjs", "scripts/publish-photos.mjs"],
    allowList: {},
  });
  assert.deepEqual(verdict.failures, [
    "scripts/publish-photos.mjs is not in the coverage report: no test loads it",
  ]);
});

test("a new script with no test fails the gate", () => {
  // The requirement the issue states in one line: adding a scripts/*.mjs that
  // nothing loads has to turn the gate red.
  const verdict = gate({
    rows: GREEN_ROWS,
    scriptFiles: ["scripts/list-orders.mjs", "scripts/brand-new.mjs"],
    allowList: {},
  });
  assert.deepEqual(verdict.failures, [
    "scripts/brand-new.mjs is not in the coverage report: no test loads it",
  ]);
});

test("a gate fixture that drops a file fails the gate", () => {
  const captured = parseCoverage(CAPTURED_SCRIPTS);
  const scriptFiles = captured.map((r) => r.file);
  const dropped = captured.filter((r) => r.file !== "scripts/publish-photos.mjs");
  const verdict = gate({ rows: dropped, scriptFiles, allowList: {} });
  assert.equal(
    verdict.failures.includes(
      "scripts/publish-photos.mjs is not in the coverage report: no test loads it",
    ),
    true,
    verdict.failures.join(", "),
  );
});

test("an allow-list entry without a reason fails the gate", () => {
  const verdict = gate({
    rows: GREEN_ROWS,
    scriptFiles: ["scripts/list-orders.mjs"],
    allowList: { "scripts/list-orders.mjs": "   " },
  });
  assert.equal(
    verdict.failures.includes("the allow-list names scripts/list-orders.mjs without a reason"),
    true,
    verdict.failures.join(", "),
  );
});

test("an allow-list entry for a script that is gone fails the gate", () => {
  const verdict = gate({
    rows: GREEN_ROWS,
    scriptFiles: ["scripts/list-orders.mjs"],
    allowList: { "scripts/deleted.mjs": "it was deleted" },
  });
  assert.equal(
    verdict.failures.includes(
      "the allow-list names scripts/deleted.mjs, which is not in scripts/ any more",
    ),
    true,
    verdict.failures.join(", "),
  );
});

test("the captured report's scripts are the ones the gate measures", () => {
  const rows = parseCoverage(CAPTURED_SCRIPTS);
  const scriptFiles = rows.map((r) => r.file);
  const verdict = gate({ rows, scriptFiles, allowList: {} });
  assert.equal(verdict.measured.scripts.length, rows.length);
  assert.equal(
    verdict.measured.scripts.some((r) => r.file === "scripts/publish-photos.mjs"),
    true,
  );
  // The src set is unchanged by any of this: the scripts are a second set,
  // measured against their own floor.
  assert.equal(verdict.measured.src.length, 0);
});

test("every script in scripts/ is measured, unless the allow-list says why", () => {
  // The assertion the issue asks for: a script cannot be outside the gate
  // without a named reason, so a new one cannot slip in untested.
  const onDisk = scriptsOnDisk();
  assert.ok(onDisk.length > 20, `expected the scripts tree, got ${onDisk.length}`);
  for (const file of onDisk) {
    const measured = isGatedScript(file);
    const allowed = file in SCRIPT_ALLOW_LIST;
    assert.equal(
      measured || allowed,
      true,
      `${file} is neither measured nor allow-listed`,
    );
    if (allowed) {
      assert.ok(SCRIPT_ALLOW_LIST[file].trim().length > 0, `${file} has no reason`);
    }
  }
  // And the allow-list names scripts that exist: an exception for a file that
  // was renamed or deleted is a hole with a name on it.
  for (const file of Object.keys(SCRIPT_ALLOW_LIST)) {
    assert.equal(onDisk.includes(file), true, `${file} is allow-listed but not on disk`);
  }
});

test("the scripts the issue names are inside the gate", () => {
  for (const file of [
    "scripts/publish-photos.mjs",
    "scripts/publish-photos-launcher.mjs",
    "scripts/list-orders.mjs",
    "scripts/migrate-orders-kv-to-d1.mjs",
    "scripts/remove-orders-kv.mjs",
  ]) {
    assert.equal(isGatedScript(file), true, file);
  }
});

test("the floors are stated over the same three metrics", () => {
  for (const floor of [SRC_FLOOR, SCRIPT_FLOOR]) {
    assert.deepEqual(Object.keys(floor).sort(), ["branches", "functions", "lines"]);
    for (const value of Object.values(floor)) {
      assert.equal(typeof value, "number");
      assert.ok(value > 0 && value <= 100, `floor out of range: ${value}`);
    }
  }
  // The src floor is the one this repo has ratcheted since the gate was
  // introduced; it must not move because scripts were added.
  assert.deepEqual(SRC_FLOOR, { lines: 99.95, branches: 99.9, functions: 100 });
});

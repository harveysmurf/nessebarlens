import assert from "node:assert/strict";
import test from "node:test";
import {
  isLibFile,
  mean,
  parseCoverage,
} from "../scripts/coverage-report.mjs";

/* The report is node's own text, so it changes shape between node majors.
   CI runs node 22 and local runs are node 20; the parser has to accept both,
   or CI fails with "no rows" while the suite is perfectly green. */

const NODE_20 = `
# start of coverage report
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------|--------|----------|---------|----------------
# src/lib/sku-map.ts           |   78.13 |     100.0 |    100.0 | 74-80
# src/lib/stripe-event.ts      |     100 |     93.33 |      100 |
# tests/sku-map.test.mts       |   94.44 |     100.0 |      100.0 | 120-126
# end of coverage report
`;

const NODE_22 = `
# start of coverage report
# -----------------------------------------------------------------------------------------------------------------------------------------------
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------------------------------------------------------------------------------------------------------------------------
# scripts                      |        |          |         | 
#  coverage-report.mjs         | 100.00 |    88.89 |  100.00 | 
# src                          |        |          |         | 
#  lib                         |        |          |         | 
#   checkout-body.ts           |  96.43 |    91.38 |  100.00 | 32 100-101 142-144
#   crypto-hex.ts              | 100.00 |   100.00 |  100.00 | 
#   derivatives.ts             | 100.00 |   100.00 |  100.00 | 
#   env.ts                     | 100.00 |   100.00 |  100.00 | 
#   fulfillment.ts             |  92.50 |    73.12 |  100.00 | 90-93 104-107 182 230 277-281 294-296 406-410 415-419 423-429 434-441 525 551-554
#   master-guard.ts            | 100.00 |   100.00 |  100.00 | 
#   master-key.ts              | 100.00 |   100.00 |  100.00 | 
#   photos.ts                  |  95.92 |   100.00 |   50.00 | 234-236 239-245
#   pricing.ts                 | 100.00 |   100.00 |  100.00 | 
#   print-asset.ts             |  91.81 |    73.17 |  100.00 | 77-78 81 99 120 122-124 127-131 133
#   prodigi-config.ts          | 100.00 |   100.00 |  100.00 | 
#   prodigi-order.ts           |  98.30 |    86.96 |  100.00 | 50-52 83
#   prodigi-quote.ts           |  96.88 |    94.12 |  100.00 | 53-55
#   ship-to-countries.ts       | 100.00 |   100.00 |  100.00 | 
#   sku-map.ts                 | 100.00 |   100.00 |  100.00 | 
#   stripe-event.ts            | 100.00 |    93.33 |  100.00 | 
#   stripe.ts                  |  47.06 |   100.00 |   50.00 | 5-13
#   worker-bindings.ts         |  97.10 |    78.57 |  100.00 | 31-32
# tests                        |        |          |         | 
#  checkout-body.test.mts      | 100.00 |   100.00 |  100.00 | 
#  coverage-report.test.mts    | 100.00 |   100.00 |  100.00 | 
#  crypto-hex.test.mts         | 100.00 |   100.00 |  100.00 | 
#  derivatives.test.mts        |  96.47 |    95.00 |  100.00 | 19-21
#  env.test.mts                | 100.00 |   100.00 |  100.00 | 
#  fulfillment.test.mts        |  98.45 |   100.00 |   93.48 | 188-192 256-261 483
#  master-guard.test.mts       | 100.00 |   100.00 |  100.00 | 
#  pricing.test.mts            | 100.00 |   100.00 |  100.00 | 
#  print-asset.test.mts        |  98.40 |    94.44 |  100.00 | 64-66
#  prodigi-order.test.mts      |  99.69 |    97.96 |   93.33 | 287
#  prodigi-quote.test.mts      |  96.77 |    83.33 |  100.00 | 44-46 68-71 74
#  register.mjs                | 100.00 |   100.00 |  100.00 | 
#  ship-to-countries.test.mts  | 100.00 |   100.00 |  100.00 | 
#  site-url.test.mts           |  92.45 |    92.31 |  100.00 | 17-20
#  sku-map.test.mts            | 100.00 |   100.00 |  100.00 | 
#  stripe-event.test.mts       | 100.00 |   100.00 |  100.00 | 
#  ts-loader.mjs               | 100.00 |   100.00 |  100.00 | 
#  ts-loader.test.mts          | 100.00 |   100.00 |  100.00 | 
#  worker-bindings.test.mts    |  95.92 |    77.78 |   57.14 | 35-36
# -----------------------------------------------------------------------------------------------------------------------------------------------
# all files                    |  97.50 |    89.28 |   96.39 | 
# -----------------------------------------------------------------------------------------------------------------------------------------------
# end of coverage report
`;

test("parses the node 20 report shape", () => {
  const rows = parseCoverage(NODE_20);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.file, "src/lib/sku-map.ts");
  assert.equal(rows[0]!.lines, 78.13);
  assert.equal(rows[0]!.branches, 100);
  assert.equal(rows[0]!.functions, 100);
  assert.equal(rows[0]!.uncovered, "74-80");
  assert.equal(rows[1]!.uncovered, "");
});


test("parses the node 22 directory tree, rebuilding full paths", () => {
  const rows = parseCoverage(NODE_22);
  // 33 source + test files in the real report, plus scripts/.
  assert.equal(rows.length, 38);
  const sku = rows.find((row) => row.file === "src/lib/sku-map.ts");
  assert.ok(sku, rows.map((row) => row.file).slice(0, 5).join(", "));
  assert.equal(sku.lines, 100);
  assert.equal(sku.functions, 100);
  const loader = rows.find((row) => row.file === "scripts/coverage-report.mjs");
  assert.ok(loader, "a file in a one-segment directory keeps its path");
  assert.equal(isLibFile(loader.file), false);
  assert.equal(isLibFile("tests/sku-map.test.mts"), false);
  assert.equal(isLibFile("src/lib/checkout-body.ts"), true);
  assert.equal(
    rows.filter((row) => isLibFile(row.file)).length,
    18,
    "all 18 src/lib files must be recognised in the tree layout",
  );
});

test("file:// and absolute paths are reduced to repo-relative ones", () => {
  const rows = parseCoverage(`
# file:///home/runner/work/nessebarlens/src/lib/sku-map.ts | 78.13 | 100.0 | 100.0 | 74-80
# /home/runner/work/nessebarlens/src/lib/stripe.ts | 47.06 | 100.0 | 50.0 | 5-13
`);
  assert.deepEqual(
    rows.map((row) => row.file),
    ["src/lib/sku-map.ts", "src/lib/stripe.ts"],
  );
  assert.equal(rows[0]!.uncovered, "74-80");
  assert.equal(isLibFile(rows[0]!.file), true);
});

test("both node layouts select the same src/lib files", () => {
  const lib20 = parseCoverage(NODE_20).filter((row) => isLibFile(row.file));
  const lib22 = parseCoverage(NODE_22).filter((row) => isLibFile(row.file));
  // Otherwise the floor means different things locally and in CI.
  assert.deepEqual(
    lib20.map((row) => row.file).sort(),
    ["src/lib/sku-map.ts", "src/lib/stripe-event.ts"],
  );
  assert.equal(lib22.every((row) => row.file.startsWith("src/lib/")), true);
});

test("header, separator and summary noise are not parsed as files", () => {
  const rows = parseCoverage(`
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------|--------|----------|---------|----------------
# all files                    |   90.05 |    88.10 |    96.40 |
# src/lib                      |   81.13 |    92.42 |    93.33 |
`);
  assert.deepEqual(rows, []);
});

test("an empty or unrelated report yields no rows rather than throwing", () => {
  assert.deepEqual(parseCoverage(""), []);
  assert.deepEqual(parseCoverage("Error: something went wrong\n"), []);
  assert.equal(mean([], "lines"), 0);
  assert.equal(mean(parseCoverage(NODE_20), "lines"), (78.13 + 100 + 94.44) / 3);
});

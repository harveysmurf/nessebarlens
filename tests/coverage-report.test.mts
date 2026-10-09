import assert from "node:assert/strict";
import test from "node:test";
import {
  isGatedFile,
  isLibFile,
  mean,
  parseCoverage,
  testRunExitCode,
} from "../scripts/coverage-report.mjs";

/* The report is node's own text, so it changes shape between node majors.
   Node >= 22 renders it as a directory tree; the flat table below is the
   pre-22 shape, kept as a fixture so the parser cannot regress to whichever
   layout the machine that wrote it happened to run. */

const NODE_24 = `
ℹ start of coverage report
ℹ ----------------------------------------------------------------
ℹ file                           | line % | branch % | funcs % | uncovered lines
ℹ ----------------------------------------------------------------
ℹ scripts                        |        |          |         | 
ℹ  coverage-report.mjs           | 100.00 |    92.59 |  100.00 | 
ℹ src                            |        |          |         | 
ℹ  domain                        |        |          |         | 
ℹ   ordering                     |        |          |         | 
ℹ    checkout-body.ts            |  97.62 |    96.67 |  100.00 | 120-121 142-143
ℹ  application                   |        |          |         | 
ℹ   fulfillment                  |        |          |         | 
ℹ    fulfillment.ts              |  96.64 |    81.28 |  100.00 | 259-260 587-590
ℹ  domain                        |        |          |         | 
ℹ   pricing                      |        |          |         | 
ℹ    sku-map.ts                  | 100.00 |   100.00 |  100.00 | 
ℹ tests                          |        |          |         | 
ℹ  register.mjs                  | 100.00 |   100.00 |  100.00 | 
ℹ ----------------------------------------------------------------
ℹ all files                      |  98.81 |    90.76 |  100.00 | 
ℹ ----------------------------------------------------------------
ℹ end of coverage report
`;

const NODE_FLAT = `
# start of coverage report
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------|--------|----------|---------|----------------
# src/domain/pricing/sku-map.ts          |   78.13 |     100.0 |    100.0 | 74-80
# src/infrastructure/stripe/stripe-event.ts |     100 |     93.33 |      100 |
# tests/sku-map.test.mts       |   94.44 |     100.0 |      100.0 | 120-126
# end of coverage report
`;

const NODE_TREE = `
# start of coverage report
# -----------------------------------------------------------------------------------------------------------------------------------------------
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------------------------------------------------------------------------------------------------------------------------
# scripts                      |        |          |         | 
#  coverage-report.mjs         | 100.00 |    88.89 |  100.00 | 
# src                          |        |          |         | 
#  application                 |        |          |         | 
#   fulfillment                |        |          |         | 
#    fulfillment.ts           |  92.50 |    73.12 |  100.00 | 90-93 104-107 182 230 277-281 294-296 406-410 415-419 423-429 434-441 525 551-554
#    print-asset.ts           |  91.81 |    73.17 |  100.00 | 77-78 81 99 120 122-124 127-131 133
#  domain                      |        |          |         | 
#   catalog                   |        |          |         | 
#    master-guard.ts          | 100.00 |   100.00 |  100.00 | 
#    master-key.ts            | 100.00 |   100.00 |  100.00 | 
#    photos.ts                |  95.92 |   100.00 |   50.00 | 234-236 239-245
#   ordering                  |        |          |         | 
#    checkout-body.ts         |  96.43 |    91.38 |  100.00 | 32 100-101 142-144
#   pricing                   |        |          |         | 
#    crypto-hex.ts            | 100.00 |   100.00 |  100.00 | 
#    pricing.ts               | 100.00 |   100.00 |  100.00 | 
#    ship-to-countries.ts     | 100.00 |   100.00 |  100.00 | 
#    sku-map.ts               | 100.00 |   100.00 |  100.00 | 
#  infrastructure              |        |          |         | 
#   cloudflare                |        |          |         | 
#    worker-bindings.ts       |  97.10 |    78.57 |  100.00 | 31-32
#   config                    |        |          |         | 
#    env.ts                   | 100.00 |   100.00 |  100.00 | 
#   media                     |        |          |         | 
#    derivatives.ts           | 100.00 |   100.00 |  100.00 | 
#   prodigi                   |        |          |         | 
#    prodigi-config.ts        | 100.00 |   100.00 |  100.00 | 
#    prodigi-order.ts         |  98.30 |    86.96 |  100.00 | 50-52 83
#    prodigi-quote.ts         |  96.88 |    94.12 |  100.00 | 53-55
#   stripe                    |        |          |         | 
#    stripe-event.ts          | 100.00 |    93.33 |  100.00 | 
#    stripe.ts                |  47.06 |   100.00 |   50.00 | 5-13
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
#  resolve-hooks.test.mjs      | 100.00 |   100.00 |  100.00 | 
#  resolve-hooks.test.mts      | 100.00 |   100.00 |  100.00 | 
#  worker-bindings.test.mts    |  95.92 |    77.78 |   57.14 | 35-36
# -----------------------------------------------------------------------------------------------------------------------------------------------
# all files                    |  97.50 |    89.28 |   96.39 | 
# -----------------------------------------------------------------------------------------------------------------------------------------------
# end of coverage report
`;

test("parses the flat pre-node-22 report shape", () => {
  const rows = parseCoverage(NODE_FLAT);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.file, "src/domain/pricing/sku-map.ts");
  assert.equal(rows[0]!.lines, 78.13);
  assert.equal(rows[0]!.branches, 100);
  assert.equal(rows[0]!.functions, 100);
  assert.equal(rows[0]!.uncovered, "74-80");
  assert.equal(rows[1]!.uncovered, "");
});


test("parses the node 24 directory tree, rebuilding full paths", () => {
  const rows = parseCoverage(NODE_TREE);
  // 33 source + test files in the real report, plus scripts/.
  assert.equal(rows.length, 38);
  const sku = rows.find((row) => row.file === "src/domain/pricing/sku-map.ts");
  assert.ok(sku, rows.map((row) => row.file).slice(0, 5).join(", "));
  assert.equal(sku.lines, 100);
  assert.equal(sku.functions, 100);
  const script = rows.find((row) => row.file === "scripts/coverage-report.mjs");
  assert.ok(script, "a file in a one-segment directory keeps its path");
  assert.equal(isLibFile(script.file), false);
  assert.equal(isLibFile("tests/sku-map.test.mts"), false);
  assert.equal(isLibFile("src/domain/ordering/checkout-body.ts"), true);
  assert.equal(
    rows.filter((row) => isLibFile(row.file)).length,
    18,
    "all 18 src/ source files must be recognised in the tree layout",
  );
});

test("the gate covers src/ source files and the api routes, and nothing else", () => {
  // Four routes sit one level under api/, the stripe webhook two — the
  // one-segment pattern that isLibFile uses would have silently skipped it.
  for (const route of [
    "src/app/api/quote/route.ts",
    "src/app/api/checkout/route.ts",
    "src/app/api/print-asset/route.ts",
    "src/app/api/download/route.ts",
    "src/app/api/webhooks/stripe/route.ts",
  ]) {
    assert.equal(isGatedFile(route), true, route);
  }
  assert.equal(isGatedFile("src/domain/catalog/photos.ts"), true);
  // The page tree and the React components are out: they need a DOM, and a
  // percentage over files that never run would be a number nobody can act on.
  assert.equal(isGatedFile("src/app/page.tsx"), false);
  assert.equal(isGatedFile("src/app/checkout/page.tsx"), false);
  assert.equal(isGatedFile("src/components/Header.tsx"), false);
  // route.ts counts under api/ only — a stray one in the page tree is a page.
  assert.equal(isGatedFile("src/app/route.ts"), false);
  assert.equal(isGatedFile("tests/routes.test.mts"), false);
  assert.equal(
    isLibFile("src/app/api/quote/route.ts"),
    false,
    "isLibFile is unchanged; the gate is wider than it deliberately",
  );
});

test("file:// and absolute paths are reduced to repo-relative ones", () => {
  const rows = parseCoverage(`
# file:///home/runner/work/nessebarlens/src/domain/pricing/sku-map.ts | 78.13 | 100.0 | 100.0 | 74-80
# /home/runner/work/nessebarlens/src/infrastructure/stripe/stripe.ts | 47.06 | 100.0 | 50.0 | 5-13
`);
  assert.deepEqual(
    rows.map((row) => row.file),
    ["src/domain/pricing/sku-map.ts", "src/infrastructure/stripe/stripe.ts"],
  );
  assert.equal(rows[0]!.uncovered, "74-80");
  assert.equal(isLibFile(rows[0]!.file), true);
});

test("both node layouts select the same src/ source files", () => {
  const libFlat = parseCoverage(NODE_FLAT).filter((row) => isLibFile(row.file));
  const libTree = parseCoverage(NODE_TREE).filter((row) => isLibFile(row.file));
  // Otherwise the floor means different things locally and in CI.
  assert.deepEqual(
    libFlat.map((row) => row.file).sort(),
    ["src/domain/pricing/sku-map.ts", "src/infrastructure/stripe/stripe-event.ts"],
  );
  assert.equal(
    libTree.every((row) => /(^|\/)src\/(?:domain|application|infrastructure)\//.test(row.file)),
    true,
  );
});

test("header, separator and summary noise are not parsed as files", () => {
  const rows = parseCoverage(`
# file                         | line % | branch % | funcs % | uncovered lines
# -----------------------------|--------|----------|---------|----------------
# all files                    |   90.05 |    88.10 |    96.40 |
# src/domain                |   81.13 |    92.42 |    93.33 |
`);
  assert.deepEqual(rows, []);
});

test("an empty or unrelated report yields no rows rather than throwing", () => {
  assert.deepEqual(parseCoverage(""), []);
  assert.deepEqual(parseCoverage("Error: something went wrong\n"), []);
  assert.equal(mean([], "lines"), 0);
  assert.equal(mean(parseCoverage(NODE_FLAT), "lines"), (78.13 + 100 + 94.44) / 3);
});

test("parses the node 24 report, whose lines carry a reporter marker", () => {
  // Captured verbatim from `npm run coverage` on node 24. Every line is
  // prefixed "ℹ " because the runner is not a TTY, which shifts the
  // indentation the tree is rebuilt from — the symptom is "parsed N rows but
  // none under the bounded-context tree" on a fully green suite.
  const rows = parseCoverage(NODE_24);
  const lib = rows.filter((row) => isLibFile(row.file));
  assert.deepEqual(
    lib.map((row) => row.file),
    ["src/domain/ordering/checkout-body.ts", "src/application/fulfillment/fulfillment.ts", "src/domain/pricing/sku-map.ts"],
  );
  assert.equal(lib[0]!.uncovered, "120-121 142-143");
  assert.equal(lib[1]!.branches, 81.28);
  assert.equal(isLibFile(rows[0]!.file), false, "scripts/ is not under src/{domain,application,infrastructure}");
});

test("the '..' rows node emits for a deep path never become a path prefix", () => {
  const rows = parseCoverage(`
ℹ ..                             |        |          |         | 
ℹ  ..                            |        |          |         | 
ℹ   tmp                          |        |          |         | 
ℹ    loader.mjs                  | 100.00 |   100.00 |  100.00 | 
`);
  assert.deepEqual(rows.map((row) => row.file), ["tmp/loader.mjs"]);
});

test("the gate fails on a red suite, and only on one", () => {
  // A failing test still emits a complete coverage report, so the gate used to
  // meet its floors on a broken suite and exit 0. The suite's own verdict has
  // to decide first.
  assert.equal(testRunExitCode({ status: 0, signal: null }), null);
  assert.equal(testRunExitCode({ status: 1, signal: null }), 1);
  assert.equal(testRunExitCode({ status: 7, signal: null }), 7);
  // Never started at all: no child, so no status and no report.
  assert.equal(testRunExitCode({ error: new Error("spawnSync ENOENT") }), 1);
  // Killed, so it has a signal but no exit code of its own to propagate.
  assert.equal(testRunExitCode({ status: null, signal: "SIGKILL" }), 1);
  // A signalled run that also reports a status is still a failure.
  assert.equal(testRunExitCode({ status: 0, signal: "SIGTERM" }), 1);
});

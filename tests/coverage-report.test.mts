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
# file | line % | branch % | func % | uncovered lines
# ------------------------------------------------------------|--------|----------|--------|--------------------
# file:///home/runner/work/nessebarlens/src/lib/sku-map.ts | 78.13 | 100.0 | 100.0 | 74-80
# /home/runner/work/nessebarlens/src/lib/stripe-event.ts | 100.00 | 93.33 | 100.00 |
# /home/runner/work/nessebarlens/tests/sku-map.test.mts | 94.44 | 100.0 | 100.0 | 120-126
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

test("parses absolute and file:// paths from newer reporters", () => {
  const rows = parseCoverage(NODE_22);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.file.endsWith("src/lib/sku-map.ts"), true);
  assert.equal(rows[0]!.lines, 78.13);
  assert.equal(rows[2]!.uncovered, "120-126");
});

test("both node shapes select the same src/lib rows", () => {
  const from20 = parseCoverage(NODE_20).filter((row) => isLibFile(row.file));
  const from22 = parseCoverage(NODE_22).filter((row) => isLibFile(row.file));
  assert.deepEqual(
    from20.map((row) => row.lines),
    from22.map((row) => row.lines),
  );
  assert.equal(from20.length, 2);
  // tests/ is not gated.
  assert.equal(parseCoverage(NODE_20).some((row) => isLibFile(row.file) && row.file.includes("tests/")), false);
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

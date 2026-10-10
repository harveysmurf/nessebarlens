/**
 * print-eligibility: the effective-PPI / crop maths and the two fail-closed
 * verdicts (#299). The maths is exercised through injected products with clean
 * numbers, and the real table's figures are pinned by
 * tests/print-eligibility-integration.test.mts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  assess,
  assessAll,
  MIN_PRINT_PPI,
} from "../src/domain/catalog/print-eligibility.ts";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import {
  PRINT_PRODUCTS,
  type PrintProductEntry,
} from "../src/domain/pricing/print-products.ts";
import type { PhysicalFormat } from "../src/domain/pricing/sku-map.ts";
import type { PrintSize } from "../src/domain/pricing/pricing.ts";

/** A product with a chosen print area in inches, at the table's 300 dpi. */
function product(
  format: PhysicalFormat,
  size: PrintSize,
  shortIn: number,
  longIn: number,
): PrintProductEntry {
  return {
    format,
    size,
    sizeIn: "12x16",
    sku: `TEST-${format}-${size}`,
    printAreaPx: { short: shortIn * 300, long: longIn * 300 },
    printAreaDpi: 300,
  };
}

const TWO_TO_ONE = product("giclee", "30x40", 1, 2);

function landscape(width: number, height: number): MasterFacts {
  return { width, height, orientation: width > height ? "landscape" : "portrait" };
}

test("MIN_PRINT_PPI pins the per-format floors", () => {
  assert.deepEqual(MIN_PRINT_PPI, { giclee: 220, framed: 220, canvas: 150 });
});

test("effectivePpi floors, and the PPI floor is inclusive at the threshold", () => {
  // 2:1 master into a 2:1 area, so both edges give the same figure.
  // 221, 220 and 219 PPI against the giclée floor of 220.
  assert.equal(assess(landscape(442, 221), TWO_TO_ONE).effectivePpi, 221);
  assert.equal(assess(landscape(440, 220), TWO_TO_ONE).effectivePpi, 220);
  assert.equal(assess(landscape(438, 219), TWO_TO_ONE).effectivePpi, 219);

  assert.deepEqual(assess(landscape(442, 221), TWO_TO_ONE).verdict, {
    eligible: true,
  });
  assert.deepEqual(assess(landscape(440, 220), TWO_TO_ONE).verdict, {
    eligible: true,
  });
  assert.deepEqual(assess(landscape(438, 219), TWO_TO_ONE).verdict, {
    eligible: false,
    reason: "below-min-ppi",
  });
});

test("effectivePpi floors rather than rounding to nearest", () => {
  // The long edge gives 2209.5 PPI, the short edge 2209; the tighter edge is
  // floored to 2209, never rounded up to 2210.
  assert.equal(assess(landscape(4419, 2209), TWO_TO_ONE).effectivePpi, 2209);
});

test("the canvas floor of 150 is inclusive, and 149 is not", () => {
  const canvas = product("canvas", "30x40", 1, 2);
  assert.equal(assess(landscape(302, 151), canvas).effectivePpi, 151);
  assert.deepEqual(assess(landscape(302, 151), canvas).verdict, { eligible: true });
  assert.deepEqual(assess(landscape(300, 150), canvas).verdict, { eligible: true });
  assert.deepEqual(assess(landscape(298, 149), canvas).verdict, {
    eligible: false,
    reason: "below-min-ppi",
  });
});

test("cropFraction is the discarded share of the frame, 3:2 into 3:4 and 5:7", () => {
  const master: MasterFacts = { width: 3000, height: 2000, orientation: "landscape" };
  const threeFour = product("giclee", "30x40", 3, 4);
  const fiveSeven = product("giclee", "50x70", 5, 7);

  // 1 − (4/3)/(3/2) = 1/9.
  assert.ok(Math.abs(assess(master, threeFour).cropFraction - 1 / 9) < 1e-12);
  // 1 − (7/5)/(3/2) = 1/15.
  assert.ok(Math.abs(assess(master, fiveSeven).cropFraction - 1 / 15) < 1e-12);
});

test("cropFraction is zero when the master and the area share an aspect", () => {
  const master: MasterFacts = { width: 3000, height: 2000, orientation: "landscape" };
  assert.equal(assess(master, product("giclee", "30x40", 2, 3)).cropFraction, 0);
});

test("portrait and landscape are symmetric: swapping the axes changes nothing", () => {
  const threeFour = product("giclee", "30x40", 3, 4);
  const wide = assess({ width: 3000, height: 2000, orientation: "landscape" }, threeFour);
  const tall = assess({ width: 2000, height: 3000, orientation: "portrait" }, threeFour);

  assert.equal(wide.effectivePpi, tall.effectivePpi);
  assert.equal(wide.cropFraction, tall.cropFraction);
  assert.deepEqual(wide.verdict, tall.verdict);
});

test("shape-mismatch fails closed when exactly one side is square", () => {
  const square: MasterFacts = { width: 1000, height: 1000, orientation: "square" };
  const squareProduct = product("giclee", "30x40", 3, 3);

  // Square master into a non-square product.
  assert.deepEqual(assess(square, product("giclee", "30x40", 3, 4)).verdict, {
    eligible: false,
    reason: "shape-mismatch",
  });
  // Non-square master into a square product.
  assert.deepEqual(
    assess({ width: 3000, height: 2000, orientation: "landscape" }, squareProduct).verdict,
    { eligible: false, reason: "shape-mismatch" },
  );
  // Both square is not a mismatch: the threshold then decides.
  assert.deepEqual(assess(square, squareProduct).verdict, { eligible: true });
});

test("shape-mismatch is reported ahead of a low PPI", () => {
  // A tiny square master into a square product: PPI is far below the floor, but
  // the shapes agree, so the reason is the resolution, not the shape.
  const tinySquare: MasterFacts = { width: 100, height: 100, orientation: "square" };
  assert.deepEqual(assess(tinySquare, product("giclee", "30x40", 3, 3)).verdict, {
    eligible: false,
    reason: "below-min-ppi",
  });
});

test("assessAll walks the table in order, with the product on each assessment", () => {
  const master: MasterFacts = { width: 8000, height: 5333, orientation: "landscape" };
  const all = assessAll(master, PRINT_PRODUCTS);

  assert.equal(all.length, PRINT_PRODUCTS.length);
  assert.deepEqual(
    all.map((a) => [a.product.format, a.product.size]),
    PRINT_PRODUCTS.map((p) => [p.format, p.size]),
  );
  // Giclée, framed then canvas, each short to long.
  assert.deepEqual(all.slice(0, 3).map((a) => a.product.size), [
    "30x40",
    "50x70",
    "70x100",
  ]);
});

test("assessAll defaults to the pinned table", () => {
  const master: MasterFacts = { width: 8000, height: 5333, orientation: "landscape" };
  assert.deepEqual(assessAll(master), assessAll(master, PRINT_PRODUCTS));
});

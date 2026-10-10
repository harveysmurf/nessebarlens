/**
 * The real masters through the real table (#299, integration — required).
 *
 * Loads the two published photos' committed master facts (#295/#297) and the
 * real PRINT_PRODUCTS (#296) with no injected table, and pins what each photo
 * is actually sold as. This is what catches a fixture change that silently
 * changes a real photo's offer: the unit tests use clean synthetic numbers and
 * would not notice.
 *
 * The giclée PPI figures are #291's problem table (harbour and golden sun at
 * 30×40, 50×70, 70×100), reproduced from the real print areas. #291 states them
 * rounded to the nearest whole PPI with a "~"; the formula here floors, so the
 * assertion is the floor of the same figure.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAll,
  MIN_PRINT_PPI,
} from "../src/domain/catalog/print-eligibility.ts";
import {
  eligibleOffer,
  parsePrintOffer,
} from "../src/domain/catalog/print-offer.ts";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import { getPhoto } from "../src/domain/catalog/photos.ts";
import { PRINT_PRODUCTS } from "../src/domain/pricing/print-products.ts";

const GOLDEN_SLUG =
  "golden-sun-flare-shining-through-stone-arch-ruins-of-saint-sophia-church-in-nessebar-bulgaria";
const HARBOUR_SLUG = "nessebar-harbour-in-black-and-white-bulgaria";

function masterOf(slug: string): MasterFacts {
  const photo = getPhoto(slug);
  assert.ok(photo, `${slug} must be in the catalog`);
  return photo.master;
}

/** `format/size` for every eligible product, in table order. */
function eligibleKeys(master: MasterFacts): string[] {
  return assessAll(master)
    .filter((a) => a.verdict.eligible)
    .map((a) => `${a.product.format}/${a.product.size}`);
}

/** The effective PPI for a `(format, size)` pair, or undefined if absent. */
function ppiOf(master: MasterFacts, format: string, size: string): number | undefined {
  return assessAll(master).find(
    (a) => a.product.format === format && a.product.size === size,
  )?.effectivePpi;
}

test("every product is assessed for both published masters", () => {
  for (const slug of [GOLDEN_SLUG, HARBOUR_SLUG]) {
    assert.equal(assessAll(masterOf(slug)).length, PRINT_PRODUCTS.length);
  }
});

test("the giclée PPIs match #291's problem table", () => {
  const golden = masterOf(GOLDEN_SLUG);
  const harbour = masterOf(HARBOUR_SLUG);

  // golden sun 7952×5304 — ~442, ~265, ~189 (exact floors).
  assert.equal(ppiOf(golden, "giclee", "30x40"), 442);
  assert.equal(ppiOf(golden, "giclee", "50x70"), 265);
  assert.equal(ppiOf(golden, "giclee", "70x100"), 189);

  // harbour 4901×3351 — ~279, ~168, ~120 (the table rounds up; the floors are
  // 279, 167 and 119).
  assert.equal(ppiOf(harbour, "giclee", "30x40"), 279);
  assert.equal(ppiOf(harbour, "giclee", "50x70"), 167);
  assert.equal(ppiOf(harbour, "giclee", "70x100"), 119);
});

test("golden sun's offer is what the table says, and nothing below the floor", () => {
  const master = masterOf(GOLDEN_SLUG);
  assert.deepEqual(eligibleKeys(master), [
    "giclee/20x30",
    "giclee/30x40",
    "giclee/30x45",
    "giclee/40x60",
    "giclee/50x70",
    "giclee/50x75",
    "giclee/60x90",
    "framed/20x30",
    "framed/30x40",
    "framed/30x45",
    "framed/40x60",
    "framed/50x70",
    "framed/50x75",
    "framed/60x90",
    "framed/70x100",
    "canvas/20x30",
    "canvas/30x40",
    "canvas/30x45",
    "canvas/40x60",
    "canvas/50x70",
    "canvas/50x75",
    "canvas/60x90",
    "canvas/70x100",
  ]);
  // Every excluded product is excluded by the PPI floor, never the shape.
  for (const assessment of assessAll(master)) {
    if (!assessment.verdict.eligible) {
      assert.equal(assessment.verdict.reason, "below-min-ppi");
    }
  }
});

test("harbour's offer is what the table says, and nothing below the floor", () => {
  const master = masterOf(HARBOUR_SLUG);
  assert.deepEqual(eligibleKeys(master), [
    "giclee/20x30",
    "giclee/30x40",
    "giclee/30x45",
    "framed/20x30",
    "framed/30x40",
    "framed/30x45",
    "framed/40x60",
    "canvas/20x30",
    "canvas/30x40",
    "canvas/30x45",
    "canvas/40x60",
  ]);
  for (const assessment of assessAll(master)) {
    if (!assessment.verdict.eligible) {
      assert.equal(assessment.verdict.reason, "below-min-ppi");
    }
  }
});

test("the derived offer round-trips through parsePrintOffer for both masters", () => {
  for (const slug of [GOLDEN_SLUG, HARBOUR_SLUG]) {
    const master = masterOf(slug);
    const result = parsePrintOffer(eligibleOffer(master), master);
    assert.equal(result.ok, true, `parsePrintOffer(${slug}) must be ok`);
    if (result.ok) assert.deepEqual(result.offer, eligibleOffer(master));
  }
});

test("no published master is square, so shape never excludes a real offer today", () => {
  for (const slug of [GOLDEN_SLUG, HARBOUR_SLUG]) {
    assert.notEqual(
      masterOf(slug).orientation,
      "square",
      `${slug} — a square master would change this photo's offer`,
    );
  }
});

test("the floors in play are the pinned per-format values", () => {
  assert.equal(MIN_PRINT_PPI.giclee, 220);
  assert.equal(MIN_PRINT_PPI.framed, 220);
  assert.equal(MIN_PRINT_PPI.canvas, 150);
});

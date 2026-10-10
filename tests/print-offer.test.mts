/**
 * print-offer: the offer shape, the validation that keeps a hand-edited offer
 * honest, the recalculation rule and the membership check (#299). The real
 * table is pinned by tests/print-eligibility-integration.test.mts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import {
  eligibleOffer,
  narrowOffer,
  offers,
  parsePrintOffer,
  type PrintOffer,
} from "../src/domain/catalog/print-offer.ts";
import type { PrintSpecification } from "../src/domain/ordering/print-spec.ts";
import { PRINT_PRODUCTS } from "../src/domain/pricing/print-products.ts";
import type { PrintSize } from "../src/domain/pricing/pricing.ts";

const GOLDEN: MasterFacts = {
  width: 7952,
  height: 5304,
  orientation: "landscape",
};
const HARBOUR: MasterFacts = {
  width: 4901,
  height: 3351,
  orientation: "landscape",
};

/** Every size on every format — the offer an owner starts from before narrowing. */
const FULL: PrintOffer = {
  giclee: ["30x40", "50x70", "70x100"],
  framed: ["30x40", "50x70", "70x100"],
  canvas: ["30x40", "50x70", "70x100"],
};

test("eligibleOffer lists only eligible sizes, per format, in table order", () => {
  assert.deepEqual(eligibleOffer(GOLDEN), {
    giclee: ["30x40", "50x70"],
    framed: ["30x40", "50x70", "70x100"],
    canvas: ["30x40", "50x70", "70x100"],
  });
  assert.deepEqual(eligibleOffer(HARBOUR), {
    giclee: ["30x40"],
    framed: ["30x40"],
    canvas: ["30x40"],
  });
});

test("an eligible offer is valid, and every format is always present", () => {
  for (const master of [GOLDEN, HARBOUR]) {
    const result = parsePrintOffer(eligibleOffer(master), master);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.offer, eligibleOffer(master));
  }
});

test("a raw offer that is not a map is `not-a-map`", () => {
  for (const raw of [null, undefined, 5, "giclee", [], [{ giclee: [] }]]) {
    assert.deepEqual(parsePrintOffer(raw, GOLDEN), {
      ok: false,
      problems: [{ format: "(offer)", reason: "not-a-map" }],
    });
  }
});

test("each absent format is a `missing-format` problem", () => {
  const result = parsePrintOffer({}, GOLDEN);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.problems.map((p) => [p.format, p.reason]).sort(),
      [
        ["canvas", "missing-format"],
        ["framed", "missing-format"],
        ["giclee", "missing-format"],
      ],
    );
  }
});

test("a key that is not a physical format is `unknown-format`", () => {
  const result = parsePrintOffer(
    { giclee: [], framed: [], canvas: [], digital: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      { format: "digital", reason: "unknown-format" },
    ]);
  }
});

test("a format whose value is not a list is `not-a-list`", () => {
  const result = parsePrintOffer(
    { giclee: "30x40", framed: [], canvas: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      { format: "giclee", reason: "not-a-list" },
    ]);
  }
});

test("a size not in the table is `unknown-size`, with the raw value when it is a string", () => {
  const result = parsePrintOffer(
    { giclee: ["99x99", 7], framed: [], canvas: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      { format: "giclee", size: "99x99", reason: "unknown-size" },
      { format: "giclee", reason: "unknown-size" },
    ]);
  }
});

test("a size the table does not offer for a format is `not-offered-for-format`", () => {
  // Drop giclée 30x40 from the table, so the pair is genuinely absent while the
  // size is still a valid PrintSize.
  const products = PRINT_PRODUCTS.filter(
    (p) => !(p.format === "giclee" && p.size === "30x40"),
  );
  const result = parsePrintOffer(
    { giclee: ["30x40"], framed: [], canvas: [] },
    GOLDEN,
    products,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      { format: "giclee", size: "30x40", reason: "not-offered-for-format" },
    ]);
  }
});

test("a repeated size is `duplicate-size`", () => {
  const result = parsePrintOffer(
    { giclee: ["30x40", "30x40"], framed: [], canvas: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      { format: "giclee", size: "30x40", reason: "duplicate-size" },
    ]);
  }
});

test("a listed option below the PPI floor is `below-min-ppi`, carrying the PPI", () => {
  const result = parsePrintOffer(
    { giclee: ["70x100"], framed: [], canvas: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems, [
      {
        format: "giclee",
        size: "70x100",
        reason: "below-min-ppi",
        effectivePpi: 189,
      },
    ]);
  }
});

test("a listed option that is square-mismatched is `shape-mismatch`", () => {
  const square: MasterFacts = { width: 4000, height: 4000, orientation: "square" };
  const result = parsePrintOffer(
    { giclee: ["30x40"], framed: [], canvas: [] },
    square,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problems[0]?.reason, "shape-mismatch");
    assert.equal(result.problems[0]?.format, "giclee");
    assert.equal(result.problems[0]?.size, "30x40");
  }
});

test("problems are collected across formats, not stopped at the first", () => {
  const result = parsePrintOffer(
    { giclee: ["70x100"], framed: "nope", canvas: [], digital: [] },
    GOLDEN,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.problems.map((p) => [p.format, p.reason]),
      [
        ["digital", "unknown-format"],
        ["giclee", "below-min-ppi"],
        ["framed", "not-a-list"],
      ],
    );
  }
});

test("narrowOffer drops options that are no longer eligible, and reports them", () => {
  const { offer, removed, newlyEligible } = narrowOffer(FULL, HARBOUR);

  assert.deepEqual(offer, eligibleOffer(HARBOUR));
  assert.deepEqual(
    removed.map((a) => [a.product.format, a.product.size]).sort(),
    [
      ["canvas", "50x70"],
      ["canvas", "70x100"],
      ["framed", "50x70"],
      ["framed", "70x100"],
      ["giclee", "50x70"],
      ["giclee", "70x100"],
    ],
  );
  assert.deepEqual(newlyEligible, []);
});

test("narrowOffer reports newly eligible options but never adds them", () => {
  const start: PrintOffer = { giclee: ["30x40"], framed: [], canvas: [] };
  const { offer, removed, newlyEligible } = narrowOffer(start, GOLDEN);

  // The owner's selection is kept verbatim; the newly eligible options are only
  // reported, never appended.
  assert.deepEqual(offer, start);
  assert.deepEqual(removed, []);
  assert.deepEqual(
    newlyEligible.map((a) => [a.product.format, a.product.size]),
    [
      ["giclee", "50x70"],
      ["framed", "30x40"],
      ["framed", "50x70"],
      ["framed", "70x100"],
      ["canvas", "30x40"],
      ["canvas", "50x70"],
      ["canvas", "70x100"],
    ],
  );
});

test("narrowOffer can remove and report a newly eligible option at once", () => {
  const start: PrintOffer = { giclee: ["70x100"], framed: [], canvas: [] };
  const { offer, removed, newlyEligible } = narrowOffer(start, GOLDEN);

  assert.deepEqual(offer, { giclee: [], framed: [], canvas: [] });
  assert.deepEqual(
    removed.map((a) => [a.product.format, a.product.size]),
    [["giclee", "70x100"]],
  );
  assert.deepEqual(
    newlyEligible.map((a) => [a.product.format, a.product.size]),
    [
      ["giclee", "30x40"],
      ["giclee", "50x70"],
      ["framed", "30x40"],
      ["framed", "50x70"],
      ["framed", "70x100"],
      ["canvas", "30x40"],
      ["canvas", "50x70"],
      ["canvas", "70x100"],
    ],
  );
});

test("narrowOffer is idempotent on an already-narrowed offer", () => {
  const once = narrowOffer(FULL, HARBOUR).offer;
  const twice = narrowOffer(once, HARBOUR);
  assert.deepEqual(twice.offer, once);
  assert.deepEqual(twice.removed, []);
  assert.deepEqual(twice.newlyEligible, []);
});

const digital: PrintSpecification = { kind: "digital" };
const gicleeSmall: PrintSpecification = {
  kind: "physical",
  format: "giclee",
  size: "30x40",
  frame: null,
};
const gicleeLarge: PrintSpecification = {
  kind: "physical",
  format: "giclee",
  size: "70x100",
  frame: null,
};

test("offers always includes digital", () => {
  assert.equal(offers({ giclee: [], framed: [], canvas: [] }, digital), true);
});

test("offers includes a physical spec exactly when its size is listed for its format", () => {
  assert.equal(offers(eligibleOffer(GOLDEN), gicleeSmall), true);
  assert.equal(offers(eligibleOffer(GOLDEN), gicleeLarge), false);
  assert.equal(offers(eligibleOffer(HARBOUR), gicleeSmall), true);
});

test("a validated offer answers offers() the way the raw lists did", () => {
  const result = parsePrintOffer(eligibleOffer(GOLDEN), GOLDEN);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(offers(result.offer, gicleeSmall), true);
    assert.equal(offers(result.offer, gicleeLarge), false);
  }
  // A size that is a PrintSize but empty on its format is not offered.
  const empty: PrintOffer = { giclee: [], framed: [], canvas: [] };
  assert.equal(offers(empty, gicleeSmall), false);
  const size: PrintSize = "30x40";
  assert.equal(offers(empty, { ...gicleeSmall, size }), false);
});

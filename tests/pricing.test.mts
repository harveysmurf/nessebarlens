import assert from "node:assert/strict";
import test from "node:test";
import {
  DIGITAL_PRICE_EUR,
  PRODIGI_MARGIN,
  eurToCents,
  formatLabel,
  merchandiseFromUnitCost,
  sizeLabel,
} from "../src/lib/pricing.ts";
import { PRINT_SIZES, SELLABLE_FORMATS } from "../src/lib/sku-map.ts";

test("merchandise applies the margin and rounds to cents", () => {
  assert.equal(merchandiseFromUnitCost(10), 12);
  assert.equal(merchandiseFromUnitCost(9.99), 11.99);
  // 33.333… EUR must not leak fractional cents to Stripe.
  assert.equal(merchandiseFromUnitCost(27.78), 33.34);
  assert.equal(merchandiseFromUnitCost(0), 0);
  assert.equal(PRODIGI_MARGIN, 1.2);
});

test("eurToCents rounds to whole cents", () => {
  assert.equal(eurToCents(30), 3000);
  assert.equal(eurToCents(19.995), 2000);
  assert.equal(eurToCents(DIGITAL_PRICE_EUR), 3000);
});

test("every sellable format has a buyer-facing label", () => {
  for (const format of SELLABLE_FORMATS) {
    const label = formatLabel(format);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `empty label for ${format}`);
  }
  // The configurator renders these verbatim; they must stay human text.
  assert.equal(formatLabel("framed"), "Framed Fine Art");
  assert.match(formatLabel("giclee"), /Gicl/);
});

test("every print size has a label with both unit systems", () => {
  for (const size of PRINT_SIZES) {
    const label = sizeLabel(size);
    assert.match(label, /cm \(/);
    assert.match(label, /"/);
  }
  assert.equal(sizeLabel(PRINT_SIZES[0]!), '30 × 40 cm (12 × 16") — Standard');
});

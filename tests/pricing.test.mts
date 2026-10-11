import assert from "node:assert/strict";
import test from "node:test";
import {
  DIGITAL_PRICE_EUR,
  PRODIGI_MARGIN,
  eurToCents,
  formatLabel,
  merchandiseFromUnitCost,
  parseEurAmount,
  sizeLabel,
} from "../src/domain/pricing/pricing.ts";
import { PRINT_SIZES, SELLABLE_FORMATS } from "../src/domain/pricing/sku-map.ts";

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
  // #334: the receipt has to match the framed print that arrives, and every
  // framed SKU is a "with mount" CFPM.
  assert.equal(formatLabel("framed"), "Framed Fine Art (White Mount)");
  assert.match(formatLabel("giclee"), /Gicl/);
  // #334: nothing on the framed path may promise glazing or paper we do not
  // ship — a CFPM is acrylic over EMA 200gsm, never glass, never Hahnemühle.
  for (const label of [formatLabel("framed"), formatLabel("giclee"), formatLabel("canvas")]) {
    assert.doesNotMatch(label, /glass/i);
  }
});

test("every print size has a label with both unit systems", () => {
  for (const size of PRINT_SIZES) {
    const label = sizeLabel(size);
    assert.match(label, /cm \(/);
    assert.match(label, /"/);
  }
  // PRINT_SIZES is in table order, small to large; the smallest is 20x30 (#303).
  assert.equal(sizeLabel(PRINT_SIZES[0]!), '20 × 30 cm (8 × 12")');
});

test("sizeLabel puts the long edge first for a landscape photo (#302)", () => {
  // The frame is portrait, but the photo hangs landscape, so its width is the
  // long edge and reads first. Portrait and square keep the short edge first.
  assert.equal(sizeLabel("30x40", "landscape"), '40 × 30 cm (16 × 12")');
  assert.equal(sizeLabel("50x70", "landscape"), '70 × 50 cm (28 × 20")');
  // A 2:3 size too (#303).
  assert.equal(sizeLabel("20x30", "landscape"), '30 × 20 cm (12 × 8")');
  assert.equal(sizeLabel("30x40", "portrait"), '30 × 40 cm (12 × 16")');
  assert.equal(sizeLabel("30x40", "square"), '30 × 40 cm (12 × 16")');
  assert.equal(sizeLabel("30x40"), '30 × 40 cm (12 × 16")');
});

test("parseEurAmount accepts plain decimal amounts and rejects the rest", () => {
  assert.equal(parseEurAmount("0"), 0);
  assert.equal(parseEurAmount("12.5"), 12.5);
  assert.equal(parseEurAmount("12.50"), 12.5);
  assert.equal(parseEurAmount("123456.78"), 123456.78);

  // Not an amount: empty, non-numeric, exponent notation, thousands separator,
  // leading zeros, and more than two decimals.
  for (const bad of [
    "",
    null,
    undefined,
    "abc",
    "1e3",
    "1,000",
    "012",
    "-1",
    "12.505",
    ".5",
  ]) {
    assert.equal(parseEurAmount(bad as string | null), null, String(bad));
  }
  // The integer part is capped at six digits. This is the divergence the
  // shared grammar resolved: prodigi-quote.ts used to accept these.
  assert.equal(parseEurAmount("1234567"), null);
  assert.equal(parseEurAmount("1234567.89"), null);
});

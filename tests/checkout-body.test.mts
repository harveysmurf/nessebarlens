import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckoutBody, parseQuoteBody } from "../src/lib/checkout-body.ts";
import {
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
  allPhysicalSkus,
} from "../src/lib/sku-map.ts";

const SLUG = { photoSlug: "saint-spiridov" };

test("checkout accepts every format×size the SKU table can build", () => {
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      const frame = format === "framed" ? "brown" : null;
      const parsed = parseCheckoutBody({ ...SLUG, format, size, frame });
      assert.deepEqual(parsed, {
        photoSlug: SLUG.photoSlug,
        format,
        size,
        frame,
        destinationCountryCode: null,
      });
      // Guard the SKU table itself so validation coverage is meaningful.
      assert.ok(allPhysicalSkus().some((e) => e.sizeCm === size));
    }
  }
});

test("checkout accepts digital and rejects size/frame for it", () => {
  const ok = parseCheckoutBody({ ...SLUG, format: "digital" });
  assert.deepEqual(ok, { ...SLUG, format: "digital", size: null, frame: null, destinationCountryCode: null });
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "digital", size: "30x40" })),
    /digital rejects size/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "digital", frame: "black" })),
    /digital rejects frame/,
  );
});

test("checkout accepts every frame finish and requires one for framed", () => {
  for (const frame of FRAME_FINISHES) {
    const parsed = parseCheckoutBody({ ...SLUG, format: "framed", size: "50x70", frame });
    assert.equal((parsed as { frame: string }).frame, frame);
  }
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "framed", size: "50x70" })),
    /frame required/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "50x70", frame: "black" })),
    /frame only allowed/,
  );
});

test("checkout rejects unknown format, size, and missing photoSlug", () => {
  assert.match(JSON.stringify(parseCheckoutBody({ ...SLUG, format: "poster", size: "30x40" })), /format must be/);
  assert.match(JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "99x99" })), /size required/);
  assert.match(JSON.stringify(parseCheckoutBody({ format: "giclee", size: "30x40" })), /photoSlug required/);
});

test("quote accepts every physical SKU combination and rejects digital", () => {
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      const frame = format === "framed" ? "white" : null;
      const parsed = parseQuoteBody({ format, size, frame });
      assert.deepEqual(parsed, { format, size, frame, destinationCountryCode: null });
    }
  }
  assert.match(
    JSON.stringify(parseQuoteBody({ format: "digital" })),
    /digital has no Prodigi quote/,
  );
});

test("checkout and quote share destination country validation", () => {
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "usa" })),
    /2-letter ISO/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "AN" })),
    /ship-to country/,
  );
  const ok = parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "DE" });
  assert.equal((ok as { destinationCountryCode: string }).destinationCountryCode, "DE");
});

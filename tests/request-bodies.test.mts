import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckoutBody, parseQuoteBody } from "../src/domain/ordering/checkout-body.ts";
import { checkoutRequest, quoteRequest } from "../src/domain/ordering/request-bodies.ts";
import {
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
} from "../src/domain/pricing/sku-map.ts";
import { SHIP_TO_COUNTRIES } from "../src/domain/pricing/ship-to-countries.ts";

const SLUG = "saint-spiridov";
const SIZE = PRINT_SIZES[0];
const FRAME = FRAME_FINISHES[0];
const COUNTRY = SHIP_TO_COUNTRIES[0].code;

// The builders exist so the client's body shape is pinned to the server's
// parser. A builder that drifts from the parser is a runtime-only failure, so
// every case round-trips through the real parser rather than asserting on the
// builder's own output.
test("quoteRequest round-trips through parseQuoteBody for every physical format", () => {
  for (const format of PHYSICAL_FORMATS) {
    const body = quoteRequest(format, SIZE, FRAME, COUNTRY);
    assert.deepEqual(parseQuoteBody(body), {
      format,
      size: SIZE,
      frame: format === "framed" ? FRAME : null,
      destinationCountryCode: COUNTRY,
    });
  }
});

test("quoteRequest drops a stale frame finish on non-framed formats", () => {
  // The parser rejects this outright ("frame only allowed when format is
  // framed"), so the builder has to omit it rather than forward the selection.
  for (const format of PHYSICAL_FORMATS.filter((f) => f !== "framed")) {
    const body = quoteRequest(format, SIZE, FRAME, COUNTRY);
    assert.equal(body.frame, null);
    assert.ok(!("error" in parseQuoteBody(body)));
  }
});

test("quoteRequest has no digital case: the parser rejects it", () => {
  assert.match(
    JSON.stringify(parseQuoteBody({ format: "digital", size: SIZE })),
    /digital has no Prodigi quote/,
  );
});

test("checkoutRequest round-trips through parseCheckoutBody for every sellable format", () => {
  for (const format of PHYSICAL_FORMATS) {
    const body = checkoutRequest(SLUG, format, SIZE, FRAME, COUNTRY);
    assert.deepEqual(parseCheckoutBody(body), {
      photoSlug: SLUG,
      format,
      size: SIZE,
      frame: format === "framed" ? FRAME : null,
      destinationCountryCode: COUNTRY,
    });
  }
  // Digital has no size or frame, so the parser drops both — the parsed shape
  // is the narrower DigitalCheckout, not the physical shape with nulls.
  const digital = parseCheckoutBody(checkoutRequest(SLUG, "digital", SIZE, FRAME, COUNTRY));
  assert.deepEqual(digital, {
    photoSlug: SLUG,
    format: "digital",
    destinationCountryCode: null,
  });
});

test("checkoutRequest nulls size, frame and country for digital", () => {
  const body = checkoutRequest(SLUG, "digital", SIZE, FRAME, COUNTRY);
  assert.deepEqual(body, {
    photoSlug: SLUG,
    format: "digital",
    size: null,
    frame: null,
    destinationCountryCode: null,
  });
});

// Non-vacuity: making the builders pass the selection through unconditionally
// must fail the two round-trip tests above, which is the drift this module
// exists to prevent.
test("forwarding a stale frame on a physical format fails the parser", () => {
  const format = "giclee" as const;
  const stale = { ...checkoutRequest(SLUG, format, SIZE, FRAME, COUNTRY), frame: FRAME };
  assert.match(
    JSON.stringify(parseCheckoutBody(stale)),
    /frame only allowed when format is framed/,
  );
});
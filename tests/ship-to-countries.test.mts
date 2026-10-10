import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SHIPPING_COUNTRY,
  isShipToCountryCode,
  SHIP_TO_COUNTRIES,
  SHIP_TO_COUNTRY_CODES,
  STRIPE_SHIP_TO_COUNTRIES,
} from "../src/domain/pricing/ship-to-countries.ts";
import { parseCheckoutBody, parseQuoteBody } from "../src/domain/ordering/checkout-body.ts";

test("ship-to list is Prodigi∩Stripe sized and defaults to BG", () => {
  assert.equal(DEFAULT_SHIPPING_COUNTRY, "BG");
  // 222: the 24-product 2:3 intersection (#303). This is +2 over the old 220
  // because the list had gone stale after the Stripe SDK added BL (St.
  // Barthélemy) and SH (St. Helena) to AllowedCountry — the regeneration the
  // gate required picked them up. No product lost a country.
  assert.equal(SHIP_TO_COUNTRIES.length, 222);
  assert.equal(SHIP_TO_COUNTRY_CODES.length, 222);
  assert.equal(STRIPE_SHIP_TO_COUNTRIES.length, 222);
  assert.ok(isShipToCountryCode("BG"));
  assert.ok(isShipToCountryCode("US"));
  assert.ok(isShipToCountryCode("JP"));
  assert.equal(isShipToCountryCode("AN"), false); // Prodigi-only, not Stripe
  assert.equal(isShipToCountryCode("CU"), false);
  assert.equal(isShipToCountryCode("XX"), false);
});

test("parseQuoteBody accepts global ship-to and rejects unknowns", () => {
  const ok = parseQuoteBody({
    format: "giclee",
    size: "30x40",
    destinationCountryCode: "US",
  });
  assert.ok(!("error" in ok));
  assert.equal(ok.destinationCountryCode, "US");

  const bad = parseQuoteBody({
    format: "giclee",
    size: "30x40",
    destinationCountryCode: "AN",
  });
  assert.ok("error" in bad);
});

test("parseCheckoutBody accepts US destination for physical", () => {
  const ok = parseCheckoutBody({
    photoSlug: "dawn",
    format: "canvas",
    size: "50x70",
    destinationCountryCode: "AU",
  });
  assert.ok(!("error" in ok));
  assert.equal(ok.destinationCountryCode, "AU");
});

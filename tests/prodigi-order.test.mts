import assert from "node:assert/strict";
import test from "node:test";
import { PHOTOS } from "../src/lib/photos.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
  placeholderAssetUrl,
  type OrderRecipient,
} from "../src/lib/prodigi-order.ts";

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

test("placeholder asset URL is public https under /placeholders", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const url = placeholderAssetUrl("dawn");
  assert.equal(url, "https://nessebarlens.com/placeholders/dawn.jpg");
  assert.match(url, /^https:\/\//);
  assert.equal(url.includes("prints/"), false);
  assert.equal(url.includes("masters"), false);
});

test("Prodigi order body uses SKU + placeholder and never leaks masters", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: "dawn",
    format: "giclee",
    size: "50x70",
    frame: null,
    recipient: RECIPIENT,
  });
  assert.equal(body.idempotencyKey, "cs_test_abcdefgh");
  assert.equal(body.merchantReference, "cs_test_abcdefgh");
  assert.equal(body.shippingMethod, "Budget");
  assert.equal(body.items[0].sku, "GLOBAL-FAP-20X28");
  assert.equal(body.items[0].sizing, "fillPrintArea");
  assert.equal(
    body.items[0].assets[0].url,
    "https://nessebarlens.com/placeholders/dawn.jpg",
  );
  assert.equal(body.recipient.address.countryCode, "BG");
  assert.equal(body.recipient.email, "buyer@example.com");
  assertNoMasterLeak(body);

  for (const photo of PHOTOS) {
    assert.equal(JSON.stringify(body).includes(photo.imageKey), false);
  }
});

test("framed order includes color attribute", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: "dawn",
    format: "framed",
    size: "30x40",
    frame: "brown",
    recipient: RECIPIENT,
  });
  assert.equal(body.items[0].sku, "GLOBAL-CFPM-12X16");
  assert.deepEqual(body.items[0].attributes, { color: "brown" });
});

test("assertNoMasterLeak rejects master keys and masters bucket names", () => {
  assert.throws(() => assertNoMasterLeak({ url: "prints/dawn.jpg" }));
  assert.throws(() =>
    assertNoMasterLeak({ bucket: "nessebar-lens-masters" }),
  );
  assert.doesNotThrow(() =>
    assertNoMasterLeak({
      url: "https://nessebarlens.com/placeholders/dawn.jpg",
    }),
  );
});

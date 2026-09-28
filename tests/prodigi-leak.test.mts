import assert from "node:assert/strict";
import test from "node:test";
import { PHOTOS } from "../src/lib/photos.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
  type OrderRecipient,
} from "../src/lib/prodigi-order.ts";

/* What may not leave the Worker. A master JPEG key in the Prodigi payload
   would be a paid-for file handed to a third party, and these are the checks
   that stand between the two. */

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "",
  phone: null,
};

test("a master imageKey anywhere in the payload is a leak, not a string", () => {
  // The bucket name and the prints/ path are checked separately. A photo's
  // imageKey is neither: it is a key in MASTERS that happens to end in .jpg,
  // so it only fails the photo loop. One photo is enough to prove the loop runs.
  const photo = PHOTOS[0]!;
  for (const value of [
    photo.imageKey,
    { nested: { deeper: [photo.imageKey] } },
    `prefix-${photo.imageKey}`,
  ]) {
    assert.throws(
      () => assertNoMasterLeak(value),
      /master-leak/,
      photo.imageKey,
    );
  }
  // Every photo, not just the first: a new catalog entry must not need a new
  // case here.
  for (const p of PHOTOS) {
    assert.throws(() => assertNoMasterLeak(p.imageKey), /master-leak/, p.slug);
  }
});

test("a non-string key of a photo is not mistaken for that photo's imageKey", () => {
  // The check is a substring test over the serialised body, so an unrelated
  // field that happens to contain part of a key would throw in production.
  assert.doesNotThrow(() =>
    assertNoMasterLeak({ note: "dawn", quantity: 1, sku: "GLOBAL-FAP-20X28" }),
  );
});

test("recipient line2, state, email and phone are only sent when present", () => {
  const body = (recipient: OrderRecipient) =>
    buildProdigiOrderBody({
      sessionId: "cs_test_abcdefgh",
      photoSlug: "dawn",
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient,
    });

  const bare = body(RECIPIENT);
  // Empty is absent, not empty: Prodigi treats an empty line2 as an address
  // line, and the buyer has none.
  assert.equal("line2" in bare.recipient.address, false);
  assert.equal("stateOrCounty" in bare.recipient.address, false);
  assert.equal("email" in bare.recipient, false);
  assert.equal("phoneNumber" in bare.recipient, false);

  const full = body({
    ...RECIPIENT,
    line2: "Apt 4",
    state: "Varna",
    email: "buyer@example.com",
    phone: "+359888123456",
  });
  assert.equal(full.recipient.address.line2, "Apt 4");
  assert.equal(full.recipient.address.stateOrCounty, "Varna");
  assert.equal(full.recipient.email, "buyer@example.com");
  assert.equal(full.recipient.phoneNumber, "+359888123456");
});

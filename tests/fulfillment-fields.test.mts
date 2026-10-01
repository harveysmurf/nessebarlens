import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFulfillment,
  parseOrderRecord,
  parseRecipient,
  type OrderRecord,
  type StripeShippingDetails,
} from "../src/lib/order-decision.ts";

/* Every scalar in a stored record is re-checked on the way out of KV. These
   are the guards that had no case at all: a record that fails one of them is
   ignored, and a guard with no case is a guard nobody has ever read. */

const SESSION = "cs_test_abcdefgh";
const NOW = "2026-09-27T12:00:00.000Z";

// isSafeAssetUrl compares against the site origin, so the assetUrl cases below
// are only meaningful if the site is the origin they use.
process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

const RECIPIENT = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: null,
  phone: null,
};

function unfulfilled(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: "dawn",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: "prodigi-error",
    masterKey: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: NOW,
    recipient: RECIPIENT,
    ...overrides,
  };
}

const SHIPPING: StripeShippingDetails = {
  name: "Test Buyer",
  phone: null,
  address: {
    line1: "1 Harbor St",
    line2: null,
    city: "Nessebar",
    state: null,
    postal_code: "8230",
    country: "BG",
  },
};

test("each scalar guard on a stored record rejects its own value", () => {
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled())));
  // A non-terminal record is a retryable Prodigi failure still eligible for
  // redelivery, so it has to survive validation — that is the paid order a
  // human is asked to refund.
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ terminal: false }))));
  for (const patch of [
    { merchantReference: "cs_test_other" },
    { merchantReference: undefined },
    { terminal: "true" },
    { terminal: 1 },
    { terminal: null },
    // "refunded"/"disputed" are real statuses now (#101). These are the
    // near-misses that must still not pass: an older reader that writes the
    // revoked status with different casing, or a status invented upstream.
    { status: "Refunded" },
    { status: "refund" },
    { status: "unpaid" },
    { status: 1 },
    { status: null },
    { format: "poster" },
    { format: "" },
    { photoSlug: 7 },
    { size: 30 },
    { frame: null },
    { quoteEur: "15" },
    { amountTotal: "1500" },
    { amountTotal: 1500.5 },
    { currency: "usd" },
    { assetUrl: 7 },
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled(patch))),
      null,
      JSON.stringify(patch),
    );
  }
  // A record with no recipient key at all is malformed, not a digital order
  // with no address: parseStoredRecipient must be reached and must refuse.
  const withoutRecipient = unfulfilled();
  delete (withoutRecipient as Record<string, unknown>).recipient;
  assert.equal(parseOrderRecord(JSON.stringify(withoutRecipient)), null);
  for (const recipient of ["", 0, false, []]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ recipient }))),
      null,
      JSON.stringify(recipient),
    );
  }
});

test("a stored euro amount may not carry sub-cent precision", () => {
  // The write path (parseEurAmount) admits 1-2 decimals only, so the read
  // guard must reject anything a write could never have produced. The previous
  // guard compared against eurToCents, which IS Math.round(v*100) — that only
  // rejected precision finer than ~1e-5, so these all passed.
  for (const quoteEur of [
    9.999999999999,
    15.000000001,
    0.30000000000000004,
    12.345,
    15.001,
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ quoteEur }))),
      null,
      `${quoteEur} should not validate`,
    );
  }
  // Every value the write path can emit must still validate, including the
  // binary-float cases (0.29 * 100 is not exactly 29).
  for (const quoteEur of [0, 0.07, 0.29, 0.3, 9.5, 15, 123.45]) {
    assert.notEqual(
      parseOrderRecord(JSON.stringify(unfulfilled({ quoteEur }))),
      null,
      `${quoteEur} should validate`,
    );
  }
});

test("a paid digital record must carry the master key its slug implies", () => {
  const digital = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 30,
    amountTotal: 3000,
    currency: "eur",
    reason: null,
    masterKey: "prints/dawn.jpg",
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: NOW,
    recipient: null,
    ...overrides,
  });
  assert.ok(parseOrderRecord(JSON.stringify(digital())));
  for (const patch of [
    { masterKey: "prints/cobblestones.jpg" },
    { masterKey: "not-a-key" },
    { photoSlug: "cobblestones" },
    { prodigiOrderId: "ord_1" },
    { assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg" },
    { recipient: RECIPIENT },
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(digital(patch))),
      null,
      JSON.stringify(patch),
    );
  }
});

test("a paid physical record must carry a Prodigi id, an asset URL and a recipient", () => {
  const physical = (overrides: Record<string, unknown> = {}) => ({
    ...unfulfilled(),
    status: "paid",
    reason: null,
    masterKey: null,
    prodigiOrderId: "ord_sandbox_1",
    prodigiStage: "InProgress",
    assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg",
    ...overrides,
  });
  assert.ok(parseOrderRecord(JSON.stringify(physical())));
  for (const patch of [
    { masterKey: "prints/dawn.jpg" },
    { prodigiOrderId: null },
    { prodigiOrderId: "" },
    { prodigiOrderId: 7 },
    { assetUrl: null },
    { assetUrl: "" },
    { assetUrl: 7 },
    { recipient: null },
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(physical(patch))),
      null,
      JSON.stringify(patch),
    );
  }
});

test("buildRecord falls back rather than producing NaN when metadata is missing", () => {
  // Metadata is attacker-influenced: a payment can arrive with the field
  // absent entirely. quoteEur and amountTotal are stored as numbers and
  // compared against the expected total, so a NaN or undefined there would
  // make every later comparison false rather than fail loudly.
  const decided = decideFulfillment({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 0 as number | null,
    metadata: null,
    shippingDetails: null,
    customerEmail: null,
    customerPhone: null,
    prodigiKeyConfigured: false,
    now: NOW,
  });
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.quoteEur, 0);
  assert.equal(record.amountTotal, 0);
  assert.equal(record.photoSlug, "");
  assert.equal(Number.isNaN(record.quoteEur), false);
  // And the record it writes is readable back.
  assert.equal(parseOrderRecord(JSON.stringify(record))?.quoteEur, 0);
});

test("a physical order with no quoteEur falls back to merchandiseEur", () => {
  // Physical metadata carries both, and only one is read. If the checkout ever
  // stops sending quoteEur, the amount check must not silently read undefined.
  const decided = decideFulfillment({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
    metadata: {
      photoSlug: "dawn",
      format: "giclee",
      size: "30x40",
      frame: "",
      merchandiseEur: "15",
      shippingEur: "4.99",
      sku: "GLOBAL-FAP-12X16",
    },
    shippingDetails: SHIPPING,
    customerEmail: null,
    customerPhone: null,
    prodigiKeyConfigured: false,
    now: NOW,
  });
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.quoteEur, 15);
  assert.equal(record.status, "paid-unfulfilled");
  // The amount matched 15 + 4.99, so the only remaining stop is the credential.
  assert.equal(record.reason, "prodigi-unconfigured");
  // Retryable, so the order is not lost: a redeploy inside Stripe's redelivery
  // window places it.
  assert.equal(record.terminal, false);
});

test("parseRecipient copes with an address that omits every optional field", () => {
  // Stripe's shipping_details is optional per field. A missing city is not the
  // same as an empty one, and (a.line1 ?? "").trim() is the difference between
  // a 400 and a crash on undefined.
  assert.equal(parseRecipient(null, null, null), null);
  assert.equal(parseRecipient({ name: "Test Buyer" } as never, null, null), null);
  const minimal = {
    name: "Test Buyer",
    phone: null,
    address: { country: "BG" },
  } as unknown as StripeShippingDetails;
  // Still rejected — the required parts are genuinely missing — but it returns
  // null rather than throwing.
  assert.equal(parseRecipient(minimal, null, null), null);

  const complete = {
    name: "Test Buyer",
    phone: null,
    address: {
      line1: "1 Harbor St",
      city: "Nessebar",
      postal_code: "8230",
      country: "BG",
    },
  } as unknown as StripeShippingDetails;
  const parsed = parseRecipient(complete, " buyer@example.com ", " +359 888 ")!;
  assert.equal(parsed.line2, "");
  assert.equal(parsed.state, "");
  assert.equal(parsed.email, "buyer@example.com");
  assert.equal(parsed.phone, "+359 888");
  // An email with no @ is not a contact address.
  assert.equal(parseRecipient(complete, "nope", null)?.email, null);
  assert.equal(parseRecipient(complete, null, null)?.phone, null);
});

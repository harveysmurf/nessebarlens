import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFulfillment,
  parseOrderRecord,
  type OrderRecord,
  type StripeShippingDetails,
} from "../src/domain/ordering/order-decision.ts";
import { SAMPLE_SLUG, SAMPLE_MASTER_KEY } from "./fixtures/sample-photo.mts";

/* The validator that reads ORDERS back. The store is key-value text that
   anything can write, so every field it accepts is re-checked on the way out —
   these are the rejection paths that were never exercised. */

const SESSION = "cs_test_abcdefgh";
const NOW = "2026-09-27T12:00:00.000Z";

// Kept set because the *generation* path still requires the site origin
// (prodigi-order.ts), so these fixtures stay realistic even though the read
// path no longer compares origins (#110).
process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

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

/** A storable physical order that is paid-unfulfilled: the widest valid shape. */
function unfulfilled(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: SAMPLE_SLUG,
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
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: null,
      phone: null,
    },
    ...overrides,
  };
}

function paidPhysical(metadata: Record<string, string>) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid" as string | null,
    currency: "eur" as string | null,
    amountTotal: 1999 as number | null,
    metadata,
    shippingDetails: SHIPPING,
    customerEmail: null as string | null,
    customerPhone: null as string | null,
    prodigiKeyConfigured: true,
    now: NOW,
  };
}

test("parseOrderRecord returns null rather than throwing on unparsable KV text", () => {
  // A truncated write, or a value written by an older schema, is text and not
  // a record. JSON.parse throwing here would surface as a 500 on every read of
  // that key, which is the opposite of "ignore this entry".
  for (const raw of ["", " ", "{", "not json", '{"v":1,', "null"]) {
    assert.equal(parseOrderRecord(raw), null, JSON.stringify(raw));
  }
  // A parseable non-object is rejected the same way, not spread into a record.
  assert.equal(parseOrderRecord("[1,2,3]"), null);
});

test("a stored sessionId is re-validated, not trusted because it round-tripped", () => {
  // Records are written from a Stripe id, but ORDERS holds text: a session id
  // that would not pass isCheckoutSessionId must not come back as an order.
  for (const sessionId of ["", "nope", "cs_", "cs_test_", 42, null]) {
    const record = unfulfilled({ sessionId, merchantReference: sessionId });
    assert.equal(
      parseOrderRecord(JSON.stringify(record)),
      null,
      `sessionId ${JSON.stringify(sessionId)}`,
    );
  }
});

test("optional stored fields reject a value of the wrong type rather than coercing it", () => {
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled())));
  for (const patch of [
    { prodigiOrderId: 17 },
    { prodigiStage: 17 },
    { prodigiStage: {} },
    { prodigiOrderId: [] },
    { masterKey: 7 },
    { reason: 7 },
    { updatedAt: 1 },
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled(patch))),
      null,
      JSON.stringify(patch),
    );
  }
  // A paid-unfulfilled record carrying a master key is a contradiction: the key
  // is only ever stored alongside a paid digital order.
  assert.equal(
    parseOrderRecord(JSON.stringify(unfulfilled({ masterKey: "masters/dawn.jpg" }))),
    null,
  );
});

test("the stored format is checked against the sellable list, not a local copy", () => {
  // fulfillment's two format guards used their own alias of the allow-list and
  // two casts. They now read isSellableFormat, so a format the catalog can
  // order must be accepted and anything else — including a shape the old
  // `(FORMATS as string[]).includes` would have reached differently — refused.
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ format: "giclee" }))));
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ format: "framed" }))));
  assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ format: "digital" }))));
  // A format string the catalog does not know is not a rejected record — it is
  // an UnknownOrder that keeps the raw string (#118), so nothing that parses
  // today stops parsing. A non-string format is still rejected.
  for (const format of ["poster", "Giclee", ""]) {
    const parsed = parseOrderRecord(JSON.stringify(unfulfilled({ format })));
    assert.notEqual(parsed, null, JSON.stringify(format));
    assert.equal(parsed!.kind, "unknown", JSON.stringify(format));
    assert.equal(parsed!.format, format, JSON.stringify(format));
  }
  for (const format of [null, 7, {}, ["giclee"]]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ format }))),
      null,
      JSON.stringify(format),
    );
  }
});

test("a legacy digital record still carrying size/frame/recipient parses as digital", () => {
  // #118: older digital records wrote a size, a frame and (in some shapes) a
  // recipient even though a digital order has none. The tolerant parser must
  // drop those extras rather than reject the record — a stored order becoming
  // unreadable is data loss, and every record that parsed before must keep
  // parsing.
  const digital = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: SAMPLE_SLUG,
    format: "digital",
    size: "50x70",
    frame: "brown",
    quoteEur: 30,
    amountTotal: 3000,
    currency: "eur",
    reason: null,
    masterKey: SAMPLE_MASTER_KEY,
    recipient: {
      name: "Legacy Buyer",
      line1: "1 Old Rd",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: null,
      phone: null,
    },
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: NOW,
  };
  const parsed = parseOrderRecord(JSON.stringify(digital));
  assert.notEqual(parsed, null, "a legacy digital record must still parse");
  assert.equal(parsed!.kind, "digital");
  assert.equal(parsed!.format, "digital");
  assert.equal(parsed!.size, "", "the stored size is dropped");
  assert.equal(parsed!.frame, "", "the stored frame is dropped");
  assert.equal(parsed!.recipient, null, "the stored recipient is dropped");
});

test("an unusable print size, or framed with no frame finish, is bad-metadata", () => {
  // The shape a stale or tampered metadata block produces. The order must
  // still be written — paid-unfulfilled, not dropped — so it stays inspectable.
  const base = {
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: "15",
    merchandiseEur: "15",
    shippingEur: "4.99",
    sku: "GLOBAL-FAP-12X16",
  };
  for (const meta of [
    { ...base, size: "99x99" },
    { ...base, format: "framed", frame: "" },
  ]) {
    const decided = decideFulfillment(paidPhysical(meta));
    assert.equal(decided.action, "write", JSON.stringify(meta));
    const record = (decided as { record: OrderRecord }).record;
    assert.equal(record.status, "paid-unfulfilled");
    assert.equal(record.reason, "bad-metadata");
    // It round-trips, so the stop is readable back out of ORDERS.
    assert.equal(
      parseOrderRecord(JSON.stringify(record))?.reason,
      "bad-metadata",
    );
  }
});

test("an asset URL on a path the site does not serve is rejected", () => {
  // isSafeAssetUrl allows one path at any origin (#110 dropped the origin
  // comparison so records survive a domain move): /api/print-asset. Any other
  // path is not what this order paid for, and would otherwise be printed in
  // place of the asset. The public-placeholder path is retired (#245).
  for (const assetUrl of [
    "https://nessebarlens.com/archive/dawn.jpg",
    "https://nessebarlens.com/",
    "https://nessebarlens.com/placeholders/../masters/dawn.jpg",
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ assetUrl }))),
      null,
      assetUrl,
    );
  }
});

test("a URL that looks like https but is not parseable is rejected", () => {
  // /^https:\/\//i is a prefix test, not a parse. "https://" passes it, so the
  // constructor's failure has to be caught rather than thrown out of the
  // validator and turned into a 500 on a download.
  for (const assetUrl of ["https://", "https://%", "https://["]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ assetUrl }))),
      null,
      assetUrl,
    );
  }
});

test("email and phone are the same string-or-null rule as the other optionals", async () => {
  // reason/masterKey/prodigiOrderId/prodigiStage/assetUrl all reject a
  // non-string, non-null value. email and phone are the same rule and had no
  // case pinning it, so a widening of that check would have gone unnoticed.
  const base = unfulfilled();
  for (const field of ["email", "phone"] as const) {
    for (const value of [17, {}, [], true, 1.5]) {
      const recipient = { ...base.recipient, [field]: value };
      assert.equal(
        parseOrderRecord(JSON.stringify(unfulfilled({ recipient }))),
        null,
        `${field} ${JSON.stringify(value)}`,
      );
    }
    // null and a string are the two accepted shapes.
    assert.ok(
      parseOrderRecord(
        JSON.stringify(unfulfilled({ recipient: { ...base.recipient, [field]: "a@b.c" } })),
      ),
      `${field} as a string`,
    );
  }
});

test("every recipient string field rejects a non-string, and a missing one is not silently empty", () => {
  // parseStoredRecipient checked all seven via a loop but read them back
  // through per-field casts, so the loop and the reads were only connected by
  // the field names being written the same way twice. Pin every key.
  const base = unfulfilled().recipient;
  const keys = [
    "name",
    "line1",
    "line2",
    "city",
    "state",
    "postcode",
    "countryCode",
  ] as const;
  for (const key of keys) {
    for (const value of [17, null, {}, [], true]) {
      const recipient = { ...base, [key]: value };
      assert.equal(
        parseOrderRecord(JSON.stringify(unfulfilled({ recipient }))),
        null,
        `${key} ${JSON.stringify(value)}`,
      );
    }
    // Deleting the key entirely is a rejection too, not an empty string.
    const { [key]: _omitted, ...withoutKey } = base;
    void _omitted;
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ recipient: withoutKey }))),
      null,
      `${key} missing`,
    );
  }
});

test("a bad countryCode is rejected on its own ISO shape, not by the string check", () => {
  // The order of the two checks matters: a non-string countryCode must be
  // rejected by the string rule, and a *string* that is not ISO alpha-2 by the
  // pattern. Merging them would let one silently cover the other.
  const base = unfulfilled().recipient;
  for (const value of ["", "B", "BGR", "bg", "12", "B G"]) {
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ recipient: { ...base, countryCode: value } }))),
      null,
      JSON.stringify(value),
    );
  }
  assert.ok(
    parseOrderRecord(JSON.stringify(unfulfilled({ recipient: { ...base, countryCode: "BG" } }))),
  );
});

test("a recipient missing email or phone entirely is rejected, not defaulted to null", () => {
  // A key absent from the JSON is `undefined`, not `null`, and the two are
  // different states in this record type. A validator that treats them alike
  // silently turns a truncated write into a valid order.
  const base = unfulfilled().recipient;
  for (const field of ["email", "phone"] as const) {
    const { [field]: _omitted, ...withoutField } = base;
    void _omitted;
    assert.equal(
      parseOrderRecord(JSON.stringify(unfulfilled({ recipient: withoutField }))),
      null,
      field,
    );
  }
});

test("the validated string keys are exactly the non-nullable recipient fields", () => {
  // RECIPIENT_STRING_KEYS is derived from OrderRecipient, so a drift is a
  // compile error — this asserts the *shape* of that derivation, so email and
  // phone being excluded by the nullability rule is visible rather than
  // implied, and the seven names are pinned in a readable place.
  const base = unfulfilled().recipient;
  const stringKeys = ["name", "line1", "line2", "city", "state", "postcode", "countryCode"];
  const nullableKeys = ["email", "phone"];
  const allKeys = [...stringKeys, ...nullableKeys];
  assert.deepEqual(Object.keys(base).sort(), [...allKeys].sort());
  // Every nullable key is accepted as null and as a string, and rejected as
  // anything else — which is what makes excluding them from the string loop
  // correct rather than an omission.
  for (const key of nullableKeys) {
    assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ recipient: { ...base, [key]: null } }))), key);
    assert.ok(parseOrderRecord(JSON.stringify(unfulfilled({ recipient: { ...base, [key]: "x" } }))), key);
    assert.equal(parseOrderRecord(JSON.stringify(unfulfilled({ recipient: { ...base, [key]: 1 } }))), null, key);
  }
});

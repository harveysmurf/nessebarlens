import assert from "node:assert/strict";
import test from "node:test";
import { MASTERS_BUCKET, referencesMasters } from "../src/lib/master-guard.ts";
import { assertNoMasterLeak } from "../src/lib/prodigi-order.ts";
import { parseOrderRecord } from "../src/lib/fulfillment.ts";

const SESSION = "cs_test_12345678abcd";

test("referencesMasters matches bucket names and prints/ key paths, any case", () => {
  assert.equal(referencesMasters("https://nessebarlens.com/placeholders/dawn.jpg"), false);
  assert.equal(
    referencesMasters(`https://r2.example/${MASTERS_BUCKET}/prints/dawn.jpg`),
    true,
  );
  assert.equal(referencesMasters("prints/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/PRINTS/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/Prints/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/api/print-asset?slug=dawn"), false);
  // The signed print-asset route is the one place "print" is allowed, and it
  // is "print-asset" with a hyphen, never "print/".
  assert.equal(referencesMasters("https://x.test/print-asset"), false);
});

test("assertNoMasterLeak rejects a master key in any case", () => {
  // The old check was case-sensitive, so "PRINTS/dawn.jpg" passed the order
  // body guard while the same string was rejected elsewhere.
  assert.throws(
    () => assertNoMasterLeak({ url: "https://x.test/PRINTS/dawn.jpg" }),
    /master-leak/,
  );
  assert.throws(
    () => assertNoMasterLeak({ url: "https://x.test/Prints/dawn.jpg" }),
    /master-leak/,
  );
  assert.throws(
    () => assertNoMasterLeak({ url: "prints/dawn.jpg" }),
    /master-leak/,
  );
  // The bucket name keeps its own message so the two causes stay tellable.
  assert.throws(
    () => assertNoMasterLeak({ url: `https://r2.example/${MASTERS_BUCKET}/a.jpg` }),
    /masters bucket referenced/,
  );
  assert.doesNotThrow(() =>
    assertNoMasterLeak({ url: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=ab" }),
  );
});

test("parseOrderRecord rejects a master asset URL in any case", () => {
  const record = {
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
    reason: null,
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=ab",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  assert.ok(parseOrderRecord(JSON.stringify(record)));
  for (const assetUrl of [
    "https://nessebarlens.com/PRINT-ASSET/../PRINTS/dawn.jpg",
    "https://nessebarlens.com/Prints/dawn.jpg",
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify({ ...record, assetUrl })),
      null,
      assetUrl,
    );
  }
});

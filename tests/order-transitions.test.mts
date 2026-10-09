import assert from "node:assert/strict";
import test from "node:test";
import {
  AWAITING_PRODIGI_REASON,
  shouldRetry,
  withProdigiFailure,
  withProdigiSuccess,
  type OrderRecord,
} from "../src/domain/ordering/order-decision.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

const NOW = "2026-10-08T12:00:00.000Z";
const SESSION = "cs_test_abcdefgh";

// A physical order mid-flight to Prodigi — the shape fulfillment.ts hands to
// the helpers after the address and key checks pass.
const PENDING: OrderRecord = {
  v: 1,
  sessionId: SESSION,
  merchantReference: SESSION,
  terminal: false,
  status: "paid-unfulfilled",
  photoSlug: SAMPLE_SLUG,
  kind: "physical",
  format: "giclee",
  size: "30x40",
  frame: "",
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
  quoteEur: 15,
  amountTotal: 1999,
  currency: "eur",
  reason: AWAITING_PRODIGI_REASON,
  masterKey: null,
  prodigiOrderId: null,
  prodigiStage: null,
  assetUrl: null,
  updatedAt: NOW,
  createdAt: NOW,
  attempts: 1,
  shipments: [],
  emailsSent: [],
};

const RETRYABLE: string[] = [
  "prodigi-auth-error",
  "prodigi-rate-limit",
  "prodigi-unavailable",
  "prodigi-timeout",
  "prodigi-asset-unconfigured",
  "prodigi-unconfigured",
];

const TERMINAL: string[] = [
  "prodigi-validation-error",
  "prodigi-error",
  "prodigi-order-foreign",
];

test("withProdigiFailure keeps retryable reasons non-terminal", () => {
  for (const reason of RETRYABLE) {
    const next = withProdigiFailure(PENDING, { reason });
    assert.equal(next.terminal, false, reason);
    assert.equal(next.reason, reason);
    assert.equal(next.prodigiOrderId, null, reason);
    assert.equal(next.prodigiStage, null, reason);
    assert.equal(next.assetUrl, null, reason);
    // Identity and money fields are untouched.
    assert.equal(next.sessionId, PENDING.sessionId);
    assert.equal(next.quoteEur, PENDING.quoteEur);
    assert.equal(next.status, "paid-unfulfilled");
  }
});

test("withProdigiFailure makes terminal reasons terminal", () => {
  for (const reason of TERMINAL) {
    const next = withProdigiFailure(PENDING, { reason });
    assert.equal(next.terminal, true, reason);
    assert.equal(next.reason, reason);
  }
});

test("withProdigiFailure output is byte-identical to the old inline rebuild", () => {
  // The exact object the two inline branches in fulfillment.ts built before the
  // extraction, so a field reorder or an extra key fails here.
  const expected = {
    ...PENDING,
    terminal: true,
    reason: "prodigi-validation-error",
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
  };
  const next = withProdigiFailure(PENDING, {
    reason: "prodigi-validation-error",
  });
  assert.equal(JSON.stringify(next), JSON.stringify(expected));
  assert.deepEqual(next, expected);
});

test("withProdigiSuccess marks the order paid and finished", () => {
  const expected = {
    ...PENDING,
    terminal: true,
    status: "paid",
    reason: null,
    masterKey: null,
    prodigiOrderId: "ord_123",
    prodigiStage: "InProgress",
    assetUrl: "https://nessebarlens.com/api/print-asset?sig=x",
  };
  const next = withProdigiSuccess(PENDING, {
    orderId: "ord_123",
    stage: "InProgress",
    assetUrl: "https://nessebarlens.com/api/print-asset?sig=x",
  });
  assert.equal(JSON.stringify(next), JSON.stringify(expected));
  assert.deepEqual(next, expected);
});

test("withProdigiSuccess accepts a null stage", () => {
  const next = withProdigiSuccess(PENDING, {
    orderId: "ord_9",
    stage: null,
    assetUrl: "https://nessebarlens.com/api/print-asset?sig=y",
  });
  assert.equal(next.prodigiStage, null);
  assert.equal(next.terminal, true);
  assert.equal(next.status, "paid");
});

test("shouldRetry is true only for a non-terminal retryable paid-unfulfilled", () => {
  assert.equal(shouldRetry(PENDING), false, "awaiting-prodigi is not retryable");
  for (const reason of RETRYABLE) {
    assert.equal(
      shouldRetry({ ...PENDING, reason }),
      true,
      `${reason} should retry`,
    );
  }
  for (const reason of TERMINAL) {
    assert.equal(
      shouldRetry({ ...PENDING, reason }),
      false,
      `${reason} is not retryable`,
    );
  }
  assert.equal(
    shouldRetry({ ...PENDING, reason: "prodigi-unavailable", terminal: true }),
    false,
    "a terminal record is a duplicate, not a retry",
  );
  assert.equal(
    shouldRetry({ ...PENDING, reason: "prodigi-unavailable", status: "paid" }),
    false,
    "a paid record is done",
  );
});

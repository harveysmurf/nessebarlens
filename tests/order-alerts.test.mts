/**
 * Every paid-but-unfulfilled order must leave a trace (#100).
 *
 * The order is stored either way — that is the customer-facing behaviour and
 * it is not what changed. What is pinned here is the second half: a structured
 * `order.unfulfilled` error log carrying sessionId and reason, exactly one per
 * store, for each reason an order can end up unfulfilled. Without it the money
 * is kept, nothing ships, Stripe gets a 200 and stops redelivering, and the
 * order is invisible until the customer complains.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { fulfillCheckoutSession } from "../src/lib/fulfillment.ts";
import {
  AWAITING_PRODIGI_REASON,
  isUnfulfilledOutcome,
  type OrderRecord,
  type StripeShippingDetails,
} from "../src/lib/order-decision.ts";
import type { CreateProdigiOrder } from "../src/lib/prodigi-order.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

const SESSION = "cs_test_abcdefgh";
const NOW = "2026-09-27T12:00:00.000Z";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

const SHIPPING: StripeShippingDetails = {
  name: "Test Buyer",
  address: {
    line1: "1 Harbor St",
    line2: "",
    city: "Nessebar",
    state: "",
    postal_code: "8230",
    country: "BG",
  },
};

function paidInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid" as string | null,
    currency: "eur" as string | null,
    amountTotal: 3000 as number | null,
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "digital",
      size: "",
      frame: "",
      quoteEur: "30",
    } as Record<string, string> | null,
    shippingDetails: null as StripeShippingDetails | null,
    customerEmail: null as string | null,
    customerPhone: null as string | null,
    prodigiKeyConfigured: false,
    now: NOW,
    // The port, not a binding: every case here starts from an empty store, and
    // a case that needs one with a record seeds it through the `store` override
    // below. A get/put-shaped fake would fail the bindings shape guard and be
    // dropped, so the alert these tests read would never be produced.
    store: memoryOrdersStore(),
    ...overrides,
  };
}

function physicalMeta(extra: Record<string, string> = {}): Record<string, string> {
  return {
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: "15",
    merchandiseEur: "15",
    shippingEur: "4.99",
    sku: "GLOBAL-FAP-12X16",
    ...extra,
  };
}

/**
 * Runs `body` with console.error captured, returning the parsed
 * `order.unfulfilled` events it emitted. Parse failures are returned as the raw
 * string so a broken payload fails the assertion with the text, not a
 * SyntaxError from inside the helper.
 */
async function captureUnfulfilled(
  body: () => Promise<void>,
): Promise<Array<Record<string, unknown> | string>> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed.event === "order.unfulfilled" ? parsed : line;
    } catch {
      return line;
    }
  });
}

test("every terminal pre-Prodigi stop logs one structured alert", async () => {
  // Each case is a paid order we keep the money for and ship nothing for.
  const cases: Array<{ reason: string; input: Record<string, unknown> }> = [
    {
      reason: "bad-metadata",
      input: paidInput({ metadata: { photoSlug: SAMPLE_SLUG, format: "nope" } }),
    },
    {
      reason: "unknown-photo",
      // A well-formed slug that is not in the catalog: past the metadata check,
      // so this is the photo lookup and not another bad-metadata.
      input: paidInput({
        metadata: { photoSlug: "no-such-photo", format: "digital", quoteEur: "30" },
      }),
    },
    {
      // Money taken for a different amount than the metadata quotes.
      reason: "amount-mismatch",
      input: paidInput({ amountTotal: 1 }),
    },
    {
      reason: "missing-shipping",
      input: paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: null,
        metadata: physicalMeta(),
      }),
    },
    ];

  for (const { reason, input } of cases) {
    const events = await captureUnfulfilled(async () => {
      const result = await fulfillCheckoutSession(input);
      assert.equal(result.body.reason, reason, reason);
    });
    const alerts = events.filter((e) => typeof e !== "string");
    assert.equal(alerts.length, 1, `${reason}: expected one alert, got ${JSON.stringify(events)}`);
    const alert = alerts[0] as Record<string, unknown>;
    assert.equal(alert.sessionId, SESSION, reason);
    assert.equal(alert.reason, reason, reason);
    assert.equal(typeof alert.terminal, "boolean", reason);
  }
});

test("both Prodigi failure kinds log, and the retryable one keeps its detail", async () => {
  const terminal: CreateProdigiOrder = async () => ({
    ok: false,
    kind: "client",
    reason: "prodigi-validation-error",
    message: "Prodigi order HTTP 400",
    status: 400,
  });
  const retryable: CreateProdigiOrder = async () => ({
    ok: false,
    kind: "server",
    reason: "prodigi-unavailable",
    message: "Prodigi order HTTP 503",
    status: 503,
  });

  const unconfigured: CreateProdigiOrder = async () => ({
    ok: false,
    kind: "server",
    reason: "prodigi-unconfigured",
    message: "PRODIGI_API_KEY is unset",
    status: null,
  });

  for (const [create, reason, httpStatus, terminalFlag] of [
    [terminal, "prodigi-validation-error", 200, true],
    [retryable, "prodigi-unavailable", 500, false],
    // A key that is not deployed is the same shape as any other retryable
    // failure: paid, unshipped, and only visible in a log.
    [unconfigured, "prodigi-unconfigured", 500, false],
  ] as const) {
    const events = await captureUnfulfilled(async () => {
      const result = await fulfillCheckoutSession({
        ...paidInput({
          amountTotal: 1999,
          prodigiKeyConfigured: true,
          shippingDetails: SHIPPING,
          metadata: physicalMeta(),
        }),
        createOrder: create,
      });
      assert.equal(result.httpStatus, httpStatus, reason);
    });
    const alerts = events.filter((e) => typeof e !== "string");
    assert.equal(alerts.length, 1, `${reason}: expected one alert, got ${JSON.stringify(events)}`);
    const alert = alerts[0] as Record<string, unknown>;
    assert.equal(alert.sessionId, SESSION, reason);
    assert.equal(alert.reason, reason, reason);
    assert.equal(alert.terminal, terminalFlag, reason);
  }
});

test("the Prodigi 503 alert carries the upstream message as detail", async () => {
  const events = await captureUnfulfilled(async () => {
    await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      createOrder: async () => ({
        ok: false,
        kind: "server",
        reason: "prodigi-unavailable",
        message: "Prodigi order HTTP 503",
        status: 503,
      }),
    });
  });
  const alert = events.find((e) => typeof e !== "string") as Record<string, unknown>;
  assert.equal(alert.detail, "Prodigi order HTTP 503");
});

test("a fulfilled order logs nothing", async () => {
  const events = await captureUnfulfilled(async () => {
    const result = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      createOrder: async () => ({
        ok: true,
        value: {
          orderId: "ord_1",
          stage: "InProgress",
          assetUrl: `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`,
        },
      }),
    });
    assert.equal(result.body.status, "paid");
  });
  assert.deepEqual(events, []);
});

test("an ignored session never reaches the store and never alerts", async () => {
  const store = memoryOrdersStore();
  const events = await captureUnfulfilled(async () => {
    await fulfillCheckoutSession({
      ...paidInput({ paymentStatus: "unpaid" }),
      store,
    });
  });
  assert.deepEqual(events, []);
  // Asserted on the store the function actually writes to: a KV-shaped fake
  // here reads nothing and makes the invariant vacuously true.
  assert.deepEqual(store.orderPuts, []);
});

test("the internal awaiting-prodigi marker is not an alert", () => {
  // buildRecord writes awaiting-prodigi on the way to Prodigi and the same
  // call rewrites it, so it is never an outcome. Pinned directly because the
  // webhook path cannot reach it: no stored order ever keeps that reason.
  const base: OrderRecord = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: SAMPLE_SLUG,
    kind: "physical",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: AWAITING_PRODIGI_REASON,
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: NOW,
    createdAt: NOW,
    attempts: 1,
    shipments: [],
    emailsSent: [],
  };
  assert.equal(isUnfulfilledOutcome(base), false);
  assert.equal(
    isUnfulfilledOutcome({ ...base, reason: "missing-shipping" }),
    true,
  );
  assert.equal(
    isUnfulfilledOutcome({ ...base, status: "paid", reason: null }),
    false,
  );
});
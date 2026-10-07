import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileOrders,
  RECONCILE_BATCH,
  RECONCILE_LOOKBACK_HOURS,
  RECONCILE_STUCK_HOURS,
  type ReconcileSession,
  type ReconcileStripe,
} from "../src/lib/reconcile.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { parseOrderRecord, type OrderRecord } from "../src/lib/order-decision.ts";
import type { CreateProdigiOrder } from "../src/lib/prodigi-order.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

const NOW = Date.parse("2026-10-03T00:00:00.000Z");

// The HMAC /api/print-asset shape a fulfilled physical order carries after
// #245; the public placeholder path is retired.
const ASSET_URL = `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`;

function session(id: string, extra: Partial<ReconcileSession> = {}): ReconcileSession {
  return {
    id,
    payment_status: "paid",
    currency: "eur",
    amount_total: 3000,
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "digital",
      size: "",
      frame: "",
      quoteEur: "30",
    },
    shipping_details: null,
    customer_details: { email: null, phone: null },
    ...extra,
  };
}

function retryable(sessionId: string, createdAt: string): OrderRecord {
  return {
    v: 1,
    sessionId,
    merchantReference: sessionId,
    terminal: false,
    status: "paid-unfulfilled",
    photoSlug: SAMPLE_SLUG,
    kind: "physical",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    // A real retryable reason: the reconciler only retries what
    // isRetryableProdigiReason accepts, and a typo'd reason would make this
    // fixture silently ineligible.
    reason: "prodigi-auth-error",
    masterKey: null,
    recipient: {
      name: "Test",
      line1: "1 St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: "t@example.com",
      phone: null,
    },
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: createdAt,
    createdAt,
    attempts: 1,
    shipments: [],
    emailsSent: [],
  };
}

test("reconcile is a no-op on an empty store", async () => {
  const store = memoryOrdersStore();
  const stripe: ReconcileStripe = {
    retrieveCheckoutSession: async () => null,
    listPaidCheckoutSessions: async () => [],
  };
  const summary = await reconcileOrders({
    store,
    stripe,
    prodigiKeyConfigured: true,
    nowMs: NOW,
  });
  assert.deepEqual(summary, {
    retried: 0,
    recovered: 0,
    claimedByOther: 0,
    stuck: 0,
    checked: 0,
    missed: 0,
    foreign: 0,
  });
});

test("reconcile retries a retryable order and skips terminal ones", async () => {
  const stuckAge = new Date(NOW - (RECONCILE_STUCK_HOURS + 1) * 3600_000).toISOString();
  const store = memoryOrdersStore();
  await store.putOrder(retryable("cs_test_retryable000000001", stuckAge));
  await store.putOrder({
    ...retryable("cs_test_terminal00000000001", stuckAge),
    terminal: true,
    reason: "prodigi-client",
  });

  let creates = 0;
  const createOrder: CreateProdigiOrder = async () => {
    creates += 1;
    return {
      ok: true,
      value: {
        orderId: "ord_1",
        stage: "InProgress",
        assetUrl: ASSET_URL,
      },
    };
  };

  const stripe: ReconcileStripe = {
    retrieveCheckoutSession: async (id) => session(id, {
      amount_total: 1999,
      metadata: {
        photoSlug: SAMPLE_SLUG,
        format: "giclee",
        size: "30x40",
        frame: "",
        quoteEur: "15",
        merchandiseEur: "15",
        shippingEur: "4.99",
        sku: "GLOBAL-FAP-12X16",
      },
      shipping_details: {
        name: "Test",
        address: {
          line1: "1 St",
          line2: "",
          city: "Nessebar",
          state: "",
          postal_code: "8230",
          country: "BG",
        },
      },
      customer_details: { email: "t@example.com", phone: null },
    }),
    listPaidCheckoutSessions: async () => [],
  };

  const errors: string[] = [];
  const real = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    const summary = await reconcileOrders({
      store,
      stripe,
      prodigiKeyConfigured: true,
      createOrder,
      nowMs: NOW,
    });
    assert.equal(summary.checked, 1);
    assert.equal(summary.retried, 1);
    assert.equal(summary.stuck, 1);
    assert.equal(creates, 1);
    assert.match(errors.join("\n"), /order\.stuck/);
  } finally {
    console.error = real;
  }
});

test("reconcile recovers a paid Stripe session with no stored order", async () => {
  const store = memoryOrdersStore();
  const stripe: ReconcileStripe = {
    retrieveCheckoutSession: async () => null,
    listPaidCheckoutSessions: async () => [session("cs_test_missedwebhook0000001")],
  };
  const summary = await reconcileOrders({
    store,
    stripe,
    prodigiKeyConfigured: true,
    createOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_collected",
        stage: "InProgress",
        assetUrl: ASSET_URL,
      },
    }),
    nowMs: NOW,
  });
  assert.equal(summary.missed, 1);
  assert.equal(summary.recovered, 1);
  assert.ok(await store.getOrder("cs_test_missedwebhook0000001"));
});

test("a retry whose claim is lost is counted as claimedByOther, not as a retry", async () => {
  // The distinction is the point of the counter: `retried` means this run placed
  // the print, `claimedByOther` means a concurrent run owns it. Folding the
  // loser into `retried` would let a summary read as "two prints placed" when
  // one was.
  const store = memoryOrdersStore();
  await store.putOrder(retryable("cs_test_lostclaim00000000001", new Date(NOW).toISOString()));
  // Every claim loses, so no Prodigi call can be made by this run.
  const losing = { ...store, async transitionOrder() { return false; } };
  let creates = 0;
  const summary = await reconcileOrders({
    store: losing,
    stripe: {
      retrieveCheckoutSession: async (id) => session(id, { amount_total: 1999 }),
      listPaidCheckoutSessions: async () => [],
    },
    prodigiKeyConfigured: true,
    createOrder: async () => {
      creates += 1;
      return { ok: true, value: { orderId: "ord_x", stage: null, assetUrl: null } };
    },
    nowMs: NOW,
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.claimedByOther, 1);
  assert.equal(summary.retried, 0);
  assert.equal(creates, 0);
});

test("a run with no arguments uses the shipped defaults, not the caller's", async () => {
  // The route passes nothing: batch, lookback and stuck-hours must come from
  // the module's own constants, and "now" from the wall clock. The order below
  // is old enough to be stuck on any clock, which is what makes this a test of
  // the defaults rather than of a fixture.
  const store = memoryOrdersStore();
  await store.putOrder(retryable("cs_test_defaults000000000001", "2020-01-01T00:00:00.000Z"));
  // Terminal, so the retryable query skips it — but it is still a stored order,
  // which is what makes the paid session below a *known* session.
  await store.putOrder({
    ...retryable("cs_test_alreadyknown0000000001", "2020-01-01T00:00:00.000Z"),
    terminal: true,
    reason: "prodigi-client",
  });
  const order = parseOrderRecord((await store.getOrder("cs_test_alreadyknown0000000001"))!)!;
  const errors: string[] = [];
  const real = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  let created: { createdGte: number; limit: number } | null = null;
  try {
    const summary = await reconcileOrders({
      store,
      stripe: {
        // A retryable order whose session Stripe no longer knows: nothing to
        // place, and the run must survive it rather than 500 on the way past.
        retrieveCheckoutSession: async () => null,
        listPaidCheckoutSessions: async (input) => {
          created = { createdGte: input.createdGte, limit: input.limit };
          // One we already know about, and one we never received a webhook for:
          // the second is the half of the reconciler that has work to do, and it
          // runs on the wall clock because this run passed no `nowMs`.
          return [
            session("cs_test_alreadyknown0000000001"),
            session("cs_test_unheardof000000000001"),
          ];
        },
      },
      prodigiKeyConfigured: false,
    });
    assert.equal(summary.checked, 1);
    assert.equal(summary.stuck, 1);
    assert.match(errors.join("\n"), /order\.stuck/);
    assert.equal(order.status, "paid-unfulfilled");
    // A paid session we already know about is not a missed webhook.
    assert.equal(summary.missed, 1);
    assert.equal(summary.recovered, 1);
    const recovered = parseOrderRecord(
      (await store.getOrder("cs_test_unheardof000000000001"))!,
    );
    assert.ok(recovered, "the unheard-of session was not recovered");
    assert.ok(
      Date.parse(recovered.updatedAt) > Date.parse("2026-01-01T00:00:00.000Z"),
      "a run with no nowMs must stamp the wall clock, not the fixture's",
    );
  } finally {
    console.error = real;
  }
  assert.ok(created);
  const lookbackSeconds = Date.now() / 1000 - (created as { createdGte: number }).createdGte;
  assert.ok(
    Math.abs(lookbackSeconds - RECONCILE_LOOKBACK_HOURS * 3600) < 60,
    `lookback should be the default, got ${lookbackSeconds} seconds`,
  );
  assert.equal((created as { limit: number }).limit, RECONCILE_BATCH);
});

test("the reconciler prefers Stripe's collected shipping over the legacy field", async () => {
  // Stripe moved shipping to `collected_information` and kept the old field
  // populated for a while. Reading the wrong one ships the print to an address
  // the customer never confirmed, so the new field has to win.
  const store = memoryOrdersStore();
  const recovered: ReconcileSession = session("cs_test_collected00000000001", {
    // 15.00 merchandise + 4.99 shipping. An amount Stripe and the metadata
    // disagree on is refused as amount-mismatch, which would hide the address
    // we are actually here to check.
    amount_total: 1999,
    customer_details: { email: "t@example.com", phone: null },
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "30x40",
      frame: "",
      quoteEur: "15",
      merchandiseEur: "15",
      shippingEur: "4.99",
      sku: "GLOBAL-FAP-12X16",
    },
    collected_information: {
      shipping_details: {
        name: "Collected",
        address: {
          line1: "9 New Rd",
          line2: "",
          city: "Sofia",
          state: "",
          postal_code: "1000",
          country: "BG",
        },
      },
    },
    shipping_details: {
      name: "Legacy",
      address: {
        line1: "1 Old Rd",
        line2: "",
        city: "Varna",
        state: "",
        postal_code: "9000",
        country: "BG",
      },
    },
  });
  const summary = await reconcileOrders({
    store,
    stripe: {
      retrieveCheckoutSession: async () => null,
      listPaidCheckoutSessions: async () => [recovered],
    },
    prodigiKeyConfigured: true,
    createOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_collected",
        stage: "InProgress",
        assetUrl: ASSET_URL,
      },
    }),
    nowMs: NOW,
  });
  assert.equal(summary.missed, 1);
  const raw = (await store.getOrder("cs_test_collected00000000001"))!;
  assert.ok(raw, "the recovered session was not stored");
  const stored = parseOrderRecord(raw);
  assert.ok(stored, `unparseable stored order: ${String(raw)}`);
  assert.equal(stored.recipient?.name, "Collected");
  assert.equal(stored.recipient?.line1, "9 New Rd");
  assert.equal(stored.recipient?.city, "Sofia");
});


// --- #193: the reconciler refuses sessions another environment created --------
//
// Stripe lists every environment's sessions on the one account, so without this
// the reconciler would adopt and fulfil a payment that belongs to another
// deployment. It must use the webhook's classifier and answer the same way.

const SITE_FOR_ORIGIN = "https://nessebarlens.com";

async function withSite<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE_FOR_ORIGIN;
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

test("a foreign-origin session is skipped: no store write, no Prodigi call", async () => {
  await withSite(async () => {
    const foreignMissed = session("cs_test_foreignmissed0000001", {
      success_url: "https://staging.nessebarlens.com/checkout/success?session_id=x",
    });
    const foreignRetry = session("cs_test_foreignretry00000001", {
      success_url: "https://nessebarlens.com.evil.test/checkout/success",
    });
    const store = memoryOrdersStore();
    await store.putOrder(
      retryable("cs_test_foreignretry00000001", "2026-10-02T23:00:00.000Z"),
    );
    const before = await store.getOrder("cs_test_foreignretry00000001");
    let prodigiCalls = 0;
    const stripe: ReconcileStripe = {
      retrieveCheckoutSession: async () => foreignRetry,
      listPaidCheckoutSessions: async () => [foreignMissed],
    };
    const summary = await reconcileOrders({
      store,
      stripe,
      prodigiKeyConfigured: true,
      createOrder: async () => {
        prodigiCalls += 1;
        throw new Error("Prodigi must not be called for a foreign session");
      },
      nowMs: NOW,
    });
    assert.equal(prodigiCalls, 0);
    assert.equal(summary.foreign, 2);
    assert.equal(summary.retried, 0);
    assert.equal(summary.missed, 0);
    assert.equal(summary.recovered, 0);
    assert.equal(await store.getOrder("cs_test_foreignmissed0000001"), null);
    assert.deepEqual(await store.getOrder("cs_test_foreignretry00000001"), before);
  });
});

test("an own-origin session, www or apex, is fulfilled; unknown is treated like the webhook treats it", async () => {
  await withSite(async () => {
    const sessions = [
      session("cs_test_ours000000000000001", {
        success_url: "https://nessebarlens.com/checkout/success?session_id=x",
      }),
      // Deliberate: www and the apex are one deployment.
      session("cs_test_wwwours0000000000001", {
        success_url: "https://www.nessebarlens.com/checkout/success?session_id=x",
      }),
      // No readable success_url is "unknown" and is accepted, not dropped.
      session("cs_test_unknown00000000000001", { success_url: null }),
      session("cs_test_garbage00000000000001", { success_url: "not a url" }),
    ];
    const store = memoryOrdersStore();
    let prodigiCalls = 0;
    const summary = await reconcileOrders({
      store,
      stripe: {
        retrieveCheckoutSession: async () => null,
        listPaidCheckoutSessions: async () => sessions,
      },
      prodigiKeyConfigured: true,
      createOrder: async () => {
        prodigiCalls += 1;
        return {
          ok: true,
          value: {
            orderId: `ord_${prodigiCalls}`,
            stage: "InProgress",
            assetUrl: ASSET_URL,
          },
        };
      },
      nowMs: NOW,
    });
    assert.equal(summary.foreign, 0);
    assert.equal(summary.recovered, 4);
    for (const s of sessions) assert.ok(await store.getOrder(s.id), s.id);
  });
});

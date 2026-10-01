/**
 * Refund and dispute revocation (#101).
 *
 * The behaviour pinned here is the customer harm: a buyer whose money came
 * back must not keep the master file. The download route already rejected
 * anything that is not `paid`, so the whole fix is these two statuses plus a
 * path that writes them — and the risky part of that path is the lookup, since
 * ORDERS is keyed by session id and the event carries a payment intent.
 *
 * Also pinned: a lookup failure must answer 5xx (Stripe redelivers) rather than
 * 200. Dropping it there is the one way this whole mechanism silently fails,
 * because every log line would still look healthy.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type OrdersKv,
} from "../src/lib/fulfillment.ts";
import {
  isOrderStatus,
  isRevoked,
  parseOrderRecord,
  resolveDownload,
} from "../src/lib/order-decision.ts";
import {
  isChargeId,
  isPaymentIntentId,
  isStripeNotFound,
  paymentIntentForDispute,
  revokeOrderByPaymentIntent,
  type StripeSessionLookup,
} from "../src/lib/order-revocation.ts";
import type { CancelProdigiOrder } from "../src/lib/prodigi-cancel.ts";

const SESSION = "cs_test_abcdefgh";
const INTENT = "pi_3AbcDefGh12345678";
const NOW = "2026-10-01T12:00:00.000Z";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

function memoryKv(seed: Record<string, string> = {}): OrdersKv & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function digitalPaidRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
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
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
    ...overrides,
  });
}

function lookup(overrides: Partial<StripeSessionLookup> = {}): StripeSessionLookup {
  return {
    findSessionIdByPaymentIntent: async () => SESSION,
    findPaymentIntentForCharge: async () => INTENT,
    ...overrides,
  };
}

async function captureErrors(body: () => Promise<void>): Promise<string[]> {
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
  return lines;
}

test("a full refund revokes the download", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });

  assert.equal(result.httpStatus, 200);
  const order = parseOrderRecord(kv.store.get(SESSION)!);
  assert.ok(order);
  assert.equal(order.status, "refunded");
  assert.equal(order.masterKey, null, "the record must stop naming the master");
  // photoSlug survives: the refund has to stay auditable.
  assert.equal(order.photoSlug, "dawn");
});

test("revocation is terminal at the download route, not just in the record", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  const order = parseOrderRecord(kv.store.get(SESSION)!);
  assert.ok(order);

  const resolved = await resolveDownload(order, undefined);
  assert.equal(resolved.kind, "json");
  assert.equal(resolved.kind === "json" ? resolved.status : 200, 409);
});

test("a dispute revokes the download", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "disputed",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(
    parseOrderRecord(kv.store.get(SESSION)!)?.status,
    "disputed",
  );
});

test("a revoked record stays parseable and still refuses to download", async () => {
  // Guards the masterKey === null rule in parseOrderRecord: if a revoked
  // record ever fails to parse, /api/download answers 500 "corrupt-order"
  // instead of refusing — the customer still cannot get the file, but the
  // operator loses the ability to see why.
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  const raw = kv.store.get(SESSION)!;
  assert.ok(parseOrderRecord(raw));
  assert.equal(JSON.parse(raw).masterKey, null);
});

test("a lookup failure answers 5xx so Stripe redelivers, and writes nothing", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const before = kv.store.get(SESSION);
  const lines = await captureErrors(() =>
    revokeOrderByPaymentIntent({
      kv,
      status: "refunded",
      paymentIntent: INTENT,
      now: NOW,
      stripe: lookup({
        findSessionIdByPaymentIntent: async () => {
          throw new Error("stripe 503");
        },
      }),
    }).then((result) => {
      assert.equal(result.httpStatus, 500);
      // Nothing written: we could not identify the order, so writing would
      // mean writing to a key we guessed.
      assert.equal(kv.store.get(SESSION), before);
    }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /order\.revocation-lookup-failed/);
});

test("an unknown payment intent and an unknown order are both 200 no-ops", async () => {
  const kv = memoryKv();
  const noSession = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup({ findSessionIdByPaymentIntent: async () => null }),
  });
  assert.equal(noSession.httpStatus, 200);
  assert.equal(noSession.body.ignored, "unknown-payment-intent");

  const noOrder = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  assert.equal(noOrder.httpStatus, 200);
  assert.equal(noOrder.body.ignored, "unknown-order");
});

test("an event with no payment intent is ignored, not guessed at", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: null,
    now: NOW,
    stripe: lookup(),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ignored, "no-payment-intent");
  assert.equal(parseOrderRecord(kv.store.get(SESSION)!)?.status, "paid");
});

test("a second refund is a duplicate, not a second write", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const first = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  const second = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
  });
  assert.equal(first.httpStatus, 200);
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.duplicate, true);
});

test("a corrupt record is logged and left alone", async () => {
  // Overwriting an unparseable record would destroy whatever a human is
  // looking at, so we refuse and complain instead.
  const kv = memoryKv({ [SESSION]: '{"v":1,"sessionId":"' + SESSION + '"}' });
  const lines = await captureErrors(() =>
    revokeOrderByPaymentIntent({
      kv,
      status: "refunded",
      paymentIntent: INTENT,
      now: NOW,
      stripe: lookup(),
    }).then((result) => {
      assert.equal(result.body.ignored, "corrupt-order");
    }),
  );
  assert.match(lines.join("\n"), /order\.corrupt/);
});

test("a physical refund attempts a Prodigi cancel and still revokes", async () => {
  const kv = memoryKv({
    [SESSION]: digitalPaidRecord({
      format: "giclee",
      size: "30x40",
      masterKey: null,
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
      prodigiOrderId: "ord_abc123",
      prodigiStage: "created",
      assetUrl: "https://nessebarlens.com/api/print-asset?photo=dawn&sig=x",
    }),
  });

  const calls: string[] = [];
  const cancel: CancelProdigiOrder = async ({ prodigiOrderId }) => {
    calls.push(prodigiOrderId);
    return { ok: true, status: 200 };
  };

  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
    cancel,
  });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(calls, ["ord_abc123"]);
  assert.equal(result.body.prodigiCancelled, true);
});

test("a failed Prodigi cancel revokes anyway and logs for a human", async () => {
  const kv = memoryKv({
    [SESSION]: digitalPaidRecord({
      format: "giclee",
      size: "30x40",
      masterKey: null,
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
      prodigiOrderId: "ord_abc123",
      prodigiStage: "in-production",
      assetUrl: "https://nessebarlens.com/api/print-asset?photo=dawn&sig=x",
    }),
  });

  const cancel: CancelProdigiOrder = async () => ({
    ok: false,
    status: 405,
    reason: "prodigi-cancel-http-405",
    message: "Prodigi cancel HTTP 405",
  });

  const lines = await captureErrors(() =>
    revokeOrderByPaymentIntent({
      kv,
      status: "disputed",
      paymentIntent: INTENT,
      now: NOW,
      stripe: lookup(),
      cancel,
    }).then((result) => {
      // Revocation is the part we owe the customer; the cancel is a courtesy.
      // A 5xx here would make Stripe redeliver a webhook that already did its
      // job, which is how a "temporary" Prodigi problem becomes a duplicate.
      assert.equal(result.httpStatus, 200);
      assert.equal(result.body.revoked, true);
      assert.equal(result.body.prodigiCancelled, false);
    }),
  );

  assert.match(lines.join("\n"), /order\.prodigi-cancel-failed/);
  assert.match(lines.join("\n"), /in-production/);
  const order = parseOrderRecord(kv.store.get(SESSION)!);
  assert.equal(order?.status, "disputed");
});

test("a digital refund never touches Prodigi", async () => {
  const kv = memoryKv({ [SESSION]: digitalPaidRecord() });
  const cancel: CancelProdigiOrder = async () => {
    throw new Error("must not be called");
  };
  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "refunded",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
    cancel,
  });
  assert.equal(result.body.prodigiCancelled, null);
});

test("a dispute resolves its payment intent through the charge hop", async () => {
  // The Dispute object names a Charge, not a PaymentIntent. Getting this wrong
  // means every dispute silently resolves to "no payment intent" and no order
  // is ever revoked.
  const seen: string[] = [];
  const found = await paymentIntentForDispute({ charge: "ch_3AbcDefGh" }, {
    findSessionIdByPaymentIntent: async () => null,
    findPaymentIntentForCharge: async (id) => {
      seen.push(id);
      return INTENT;
    },
  });
  assert.equal(found, INTENT);
  assert.deepEqual(seen, ["ch_3AbcDefGh"]);
});

test("a dispute already carrying a payment intent skips the extra hop", async () => {
  const found = await paymentIntentForDispute(
    { charge: { payment_intent: INTENT } },
    lookup({
      findPaymentIntentForCharge: async () => {
        throw new Error("must not be called");
      },
    }),
  );
  assert.equal(found, INTENT);
});

test("a transient dispute charge lookup propagates instead of resolving to null", async () => {
  // Must NOT be swallowed. Resolving to null here made the route answer 200
  // "no-payment-intent", so Stripe did not redeliver and a disputed buyer kept
  // the master file. The throw is what becomes the 500.
  await assert.rejects(
    paymentIntentForDispute({ charge: "ch_3AbcDefGh" }, {
      findSessionIdByPaymentIntent: async () => null,
      findPaymentIntentForCharge: async () => {
        throw new Error("stripe 500");
      },
    }),
    /stripe 500/,
  );
});

test("a dispute with no charge at all is ignorable, not an error", async () => {
  // Nothing to look up and nothing that could fail: this is a 200.
  assert.equal(
    await paymentIntentForDispute({}, lookup()),
    null,
  );
});

test("isStripeNotFound separates a missing charge from a Stripe outage", () => {
  // Definitive not-found: the charge is not ours, ignore it.
  assert.equal(isStripeNotFound({ statusCode: 404 }), true);
  assert.equal(isStripeNotFound({ type: "StripeInvalidRequestError" }), true);
  assert.equal(isStripeNotFound({ code: "resource_missing" }), true);
  // Transient: these must rethrow so Stripe redelivers.
  assert.equal(isStripeNotFound({ statusCode: 500 }), false);
  assert.equal(isStripeNotFound({ statusCode: 429 }), false);
  assert.equal(isStripeNotFound({ type: "StripeAPIError", statusCode: 503 }), false);
  assert.equal(isStripeNotFound(new Error("network down")), false);
  assert.equal(isStripeNotFound(null), false);
  assert.equal(isStripeNotFound("nope"), false);
});

test("malformed ids are rejected before they reach an API", () => {
  assert.equal(isPaymentIntentId(INTENT), true);
  assert.equal(isPaymentIntentId("pi_short"), false);
  assert.equal(isPaymentIntentId(SESSION), false);
  assert.equal(isPaymentIntentId(null), false);
  assert.equal(isChargeId("ch_3AbcDefGh"), true);
  assert.equal(isChargeId(INTENT), false);
});

test("isOrderStatus rejects a non-string so a junk record cannot parse", () => {
  assert.equal(isOrderStatus("paid"), true);
  assert.equal(isOrderStatus("paid-unfulfilled"), true);
  assert.equal(isOrderStatus("refunded"), true);
  assert.equal(isOrderStatus("disputed"), true);
  assert.equal(isOrderStatus("nonsense"), false);
  assert.equal(isOrderStatus(7), false);
  assert.equal(isOrderStatus(null), false);
  assert.equal(isRevoked("refunded"), true);
  assert.equal(isRevoked("paid"), false);
});
test("a dispute with no charge, or an unusable one, resolves to null", async () => {
  // Every one of these is a shape we did not expect. All of them resolve to
  // "no payment intent", which the caller treats as an ignored event — never
  // as a charge to look up.
  const noLookup = lookup({
    findPaymentIntentForCharge: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(await paymentIntentForDispute({}, noLookup), null);
  assert.equal(await paymentIntentForDispute({ charge: null }, noLookup), null);
  // A charge id that is not a charge id is a payload we do not understand.
  assert.equal(await paymentIntentForDispute({ charge: "not-a-charge" }, noLookup), null);
  // An expanded Dispute whose embedded charge carries no usable intent.
  assert.equal(
    await paymentIntentForDispute({ charge: { payment_intent: "nope" } }, noLookup),
    null,
  );
  assert.equal(await paymentIntentForDispute({ charge: { payment_intent: null } }, noLookup), null);
});

test("a lookup that throws something without a message still logs", async () => {
  // Stripe's client can reject with a non-Error. The log must not lose the
  // event entirely because there was no .message to interpolate.
  const lines = await captureErrors(() =>
    revokeOrderByPaymentIntent({
      kv: memoryKv(),
      status: "refunded",
      paymentIntent: INTENT,
      now: NOW,
      stripe: lookup({
        findSessionIdByPaymentIntent: async () => {
          throw "plain string failure";
        },
      }),
    }).then((result) => {
      assert.equal(result.httpStatus, 500);
    }),
  );
  assert.match(lines.join("\n"), /order\.revocation-lookup-failed/);
  assert.match(lines.join("\n"), /unknown/);
});

test("the default lookup asks Stripe for the session the payment came from", async () => {
  // The seam that made option (A) unnecessary: no second KV index, one read
  // against the API /api/checkout already calls. This exercises the real
  // client, so the endpoint and the field names are pinned rather than assumed.
  const saved = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_revocation";
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    seen.push(`${init?.method ?? "GET"} ${target}`);
    if (target.includes("/checkout/sessions")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: SESSION }], has_more: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/charges/")) {
      // A Charge whose payment_intent is expanded as an object rather than a
      // string, which the API does for some versions. Resolving it to null
      // is correct; crashing is not.
      return new Response(
        JSON.stringify({ id: "ch_1", payment_intent: { id: INTENT } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
  try {
    const { defaultStripeLookup } = await import("../src/lib/order-revocation.ts");
    const live = defaultStripeLookup();
    assert.equal(await live.findSessionIdByPaymentIntent(INTENT), SESSION);
    assert.ok(
      seen.some((line) => line.includes("/checkout/sessions")),
      "the lookup must ask Stripe which session the payment came from",
    );
    assert.equal(await live.findPaymentIntentForCharge("ch_1"), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
  }
});

test("a physical refund uses the real cancel when none is injected", async () => {
  // The default must be the production path, not a no-op: this pins that a
  // physical revocation without an injected cancel still reaches Prodigi.
  const saved = { ...process.env };
  delete process.env.PRODIGI_API_BASE;
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  delete process.env.PRODIGI_API_KEY;
  const kv = memoryKv({
    [SESSION]: digitalPaidRecord({
      format: "canvas",
      size: "30x40",
      masterKey: null,
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
      prodigiOrderId: "ord_abc123",
      prodigiStage: "created",
      assetUrl: "https://nessebarlens.com/api/print-asset?photo=dawn&sig=x",
    }),
  });
  const lines = await captureErrors(() =>
    revokeOrderByPaymentIntent({
      kv,
      status: "refunded",
      paymentIntent: INTENT,
      now: NOW,
      stripe: lookup(),
    }).then((result) => {
      // Unconfigured Prodigi, so the cancel fails — and the revocation still
      // stands, which is the whole point of writing before cancelling.
      assert.equal(result.httpStatus, 200);
      assert.equal(result.body.revoked, true);
      assert.equal(result.body.prodigiCancelled, false);
    }),
  );
  assert.match(lines.join("\n"), /order\.prodigi-cancel-failed/);
  assert.equal(parseOrderRecord(kv.store.get(SESSION)!)?.status, "refunded");
  for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY", "PRODIGI_API_KEY"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("a physical order with no Prodigi id is revoked without a cancel", async () => {
  // paid-unfulfilled physical orders carry no prodigiOrderId. There is nothing
  // to cancel, and inventing a call would be a request to a URL we made up.
  const kv = memoryKv({
    [SESSION]: digitalPaidRecord({
      format: "giclee",
      size: "30x40",
      masterKey: null,
      status: "paid-unfulfilled",
      reason: "awaiting-prodigi",
      terminal: false,
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
      prodigiOrderId: null,
      prodigiStage: null,
      assetUrl: null,
    }),
  });
  const cancel: CancelProdigiOrder = async () => {
    throw new Error("there is no order id to cancel");
  };
  const result = await revokeOrderByPaymentIntent({
    kv,
    status: "disputed",
    paymentIntent: INTENT,
    now: NOW,
    stripe: lookup(),
    cancel,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.prodigiCancelled, null);
  assert.equal(parseOrderRecord(kv.store.get(SESSION)!)?.status, "disputed");
});

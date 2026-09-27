import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Stripe from "stripe";
import {
  EU_FLAT_SHIPPING_CENTS,
  SKU_MAP_READY,
  decideFulfillment,
  expectedAmountCents,
  fulfillCheckoutSession,
  parseOrderRecord,
  resolveDownload,
  type MastersBucket,
  type OrderRecord,
  type OrdersKv,
} from "../src/lib/fulfillment.ts";
import { masterKeyForSlug } from "../src/lib/master-key.ts";
import { getPhoto } from "../src/lib/photos.ts";
import { readStripeEvent } from "../src/lib/stripe-event.ts";

const NOW = "2026-09-27T12:00:00.000Z";
const SESSION = "cs_test_abcdefgh";

function memoryKv(initial?: Record<string, string>): OrdersKv & { puts: string[] } {
  const store = new Map(Object.entries(initial ?? {}));
  const puts: string[] = [];
  return {
    puts,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value) {
      puts.push(key);
      store.set(key, value);
    },
  };
}

function paidInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid" as string | null,
    currency: "eur" as string | null,
    amountTotal: 3000 as number | null,
    metadata: {
      photoSlug: "dawn",
      format: "digital",
      size: "",
      frame: "",
      quoteEur: "30",
    } as Record<string, string> | null,
    prodigiKeyConfigured: false,
    now: NOW,
    ...overrides,
  };
}

test("shipping lock is 1200 cents and the SKU map is not ready", () => {
  assert.equal(EU_FLAT_SHIPPING_CENTS, 1200);
  assert.equal(SKU_MAP_READY, false);
  assert.equal(expectedAmountCents("digital", 30), 3000);
  assert.equal(expectedAmountCents("giclee", 45), 4500 + 1200);
});

test("digital payment with a matching total is paid and does not call Prodigi", async () => {
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({ ...paidInput(), kv });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.reason, null);
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.masterKey, getPhoto("dawn")?.imageKey);
  assert.equal(stored.terminal, true);
  assert.equal(stored.merchantReference, SESSION);
  assert.equal(stored.format, "digital");
});

test("physical payment is paid-unfulfilled even when a Prodigi key is configured", async () => {
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 45 * 100 + EU_FLAT_SHIPPING_CENTS,
      prodigiKeyConfigured: true,
      metadata: {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
        frame: "",
        quoteEur: "45",
      },
    }),
    kv,
  });
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "sku-map-missing");
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.masterKey, null);
});

test("amount mismatch and missing shipping are permanent stops", () => {
  const digitalWithShipping = decideFulfillment(
    paidInput({ amountTotal: 3000 + EU_FLAT_SHIPPING_CENTS }),
  );
  assert.equal(digitalWithShipping.action, "write");
  if (digitalWithShipping.action === "write") {
    assert.equal(digitalWithShipping.record.reason, "amount-mismatch");
    assert.equal(digitalWithShipping.record.masterKey, null);
  }

  const physicalWithoutShipping = decideFulfillment(
    paidInput({
      amountTotal: 4500,
      metadata: {
        photoSlug: "dawn",
        format: "framed",
        size: "30x40",
        frame: "black",
        quoteEur: "45",
      },
    }),
  );
  assert.equal(physicalWithoutShipping.action, "write");
  if (physicalWithoutShipping.action === "write") {
    assert.equal(physicalWithoutShipping.record.reason, "amount-mismatch");
  }
});

test("bad metadata, unknown photo, and unpaid sessions do not become downloads", () => {
  const bad = decideFulfillment(
    paidInput({ metadata: { photoSlug: "dawn", format: "nope", quoteEur: "30" } }),
  );
  assert.equal(bad.action, "write");
  if (bad.action === "write") assert.equal(bad.record.reason, "bad-metadata");

  const unknown = decideFulfillment(
    paidInput({
      metadata: {
        photoSlug: "not-a-photo",
        format: "digital",
        size: "",
        frame: "",
        quoteEur: "30",
      },
    }),
  );
  assert.equal(unknown.action, "write");
  if (unknown.action === "write") {
    assert.equal(unknown.record.reason, "unknown-photo");
    assert.equal(unknown.record.masterKey, null);
  }

  const unpaid = decideFulfillment(paidInput({ paymentStatus: "unpaid" }));
  assert.deepEqual(unpaid, { action: "ignore", reason: "unpaid" });
});

test("a second delivery does not overwrite the first ORDERS record", async () => {
  const kv = memoryKv();
  await fulfillCheckoutSession({ ...paidInput(), kv });
  const first = await kv.get(SESSION);
  const again = await fulfillCheckoutSession({
    ...paidInput({ amountTotal: 1 }),
    kv,
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(kv.puts.length, 1);
  assert.equal(await kv.get(SESSION), first);
});

test("download waits until ORDERS has a paid digital session, then streams MASTERS", async () => {
  const calls: string[] = [];
  const masters: MastersBucket = {
    async get(key) {
      calls.push(key);
      return {
        body: new ReadableStream(),
        size: 12,
        contentType: "image/jpeg",
      };
    },
  };

  const paid = parseOrderRecord(
    JSON.stringify(
      (
        decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
      ).record,
    ),
  );
  assert.ok(paid);
  const streamed = await resolveDownload(paid, masters);
  assert.equal(streamed.kind, "stream");
  if (streamed.kind === "stream") {
    assert.equal(streamed.filename, "dawn.jpg");
    assert.equal(streamed.contentType, "image/jpeg");
  }
  assert.deepEqual(calls, ["prints/dawn.jpg"]);

  const physical = decideFulfillment(
    paidInput({
      amountTotal: 4500 + EU_FLAT_SHIPPING_CENTS,
      metadata: {
        photoSlug: "dawn",
        format: "canvas",
        size: "30x40",
        frame: "",
        quoteEur: "45",
      },
    }),
  );
  assert.equal(physical.action, "write");
  if (physical.action === "write") {
    const blocked = await resolveDownload(physical.record, {
      async get() {
        throw new Error("masters must not be read");
      },
    });
    assert.equal(blocked.kind, "json");
    if (blocked.kind === "json") assert.equal(blocked.status, 403);
  }
});

test("missing MASTERS binding and missing object are distinct", async () => {
  const paid = (
    decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
  ).record;
  const unavailable = await resolveDownload(paid, undefined);
  assert.equal(unavailable.kind, "json");
  if (unavailable.kind === "json") {
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error, "masters-unavailable");
  }
  const missing = await resolveDownload(paid, { async get() { return null; } });
  assert.equal(missing.kind, "json");
  if (missing.kind === "json") assert.equal(missing.status, 404);
});

function webhookPayload() {
  return JSON.stringify({
    id: "evt_test_webhook",
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: 1_700_000_000,
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION,
        object: "checkout.session",
        payment_status: "paid",
        currency: "eur",
        amount_total: 3000,
        metadata: {
          photoSlug: "dawn",
          format: "digital",
          size: "",
          frame: "",
          quoteEur: "30",
        },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
}

test("webhook signature is checked against the raw body", async () => {
  const secret = "whsec_test_secret_value";
  const payload = webhookPayload();
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = await readStripeEvent(payload, header, secret);
  assert.equal(event.type, "checkout.session.completed");
  await assert.rejects(() => readStripeEvent(payload, header, "whsec_other"));
  await assert.rejects(() =>
    readStripeEvent(payload.replace("dawn", "dusk"), header, secret),
  );
});

test("web crypto verifies when constructEvent cannot run, and a bad signature does not fall through", async () => {
  const secret = "whsec_test_secret_value";
  const payload = webhookPayload();
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = await readStripeEvent(payload, header, secret, {
    construct() {
      throw new Error("createHmac is not a function");
    },
  });
  assert.equal(event.type, "checkout.session.completed");

  await assert.rejects(() =>
    readStripeEvent(payload.replace("dawn", "dusk"), header, secret, {
      construct() {
        throw new Error("createHmac is not a function");
      },
    }),
  );

  const stale = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: Math.floor(Date.now() / 1000) - 1000,
  });
  await assert.rejects(() =>
    readStripeEvent(payload, stale, secret, {
      construct() {
        throw new Error("createHmac is not a function");
      },
    }),
  );

  await assert.rejects(() =>
    readStripeEvent(payload, header, secret, {
      construct() {
        throw new Stripe.errors.StripeSignatureVerificationError(header, payload, {
          message: "No signatures found matching the expected signature for payload.",
        });
      },
    }),
  );
});

test("fulfillment source does not call Prodigi or fetch", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const rel of [
    "src/lib/fulfillment.ts",
    "src/lib/master-key.ts",
    "src/lib/stripe-event.ts",
    "src/lib/worker-bindings.ts",
    "src/app/api/webhooks/stripe/route.ts",
    "src/app/api/download/route.ts",
  ]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(src.includes("fetch("), false, rel);
    assert.equal(src.includes("prodigi.com"), false, rel);
    assert.equal(src.includes("r2.dev"), false, rel);
  }
  const fulfillment = fs.readFileSync(path.join(root, "src/lib/fulfillment.ts"), "utf8");
  assert.equal(fulfillment.includes("MASTER_KEYS"), false);
  assert.equal(masterKeyForSlug("dawn"), getPhoto("dawn")?.imageKey);
  assert.equal(masterKeyForSlug("not-a-photo"), null);
});

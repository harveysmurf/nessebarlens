import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Stripe from "stripe";
import {
  SKU_MAP_READY,
  decideFulfillment,
  expectedAmountCents,
  fulfillCheckoutSession,
  parseOrderRecord,
  parseRecipient,
  resolveDownload,
  type MastersBucket,
  type OrderRecord,
  type OrdersKv,
  type StripeShippingDetails,
} from "../src/lib/fulfillment.ts";
import { masterKeyForSlug } from "../src/lib/master-key.ts";
import { getPhoto } from "../src/lib/photos.ts";
import { FRAME_FINISHES, PHYSICAL_FORMATS, PRINT_SIZES } from "../src/lib/sku-map.ts";
import { readStripeEvent } from "../src/lib/stripe-event.ts";
import { eurToCents } from "../src/lib/pricing.ts";
import type { CreateProdigiOrder } from "../src/lib/prodigi-order.ts";

const NOW = "2026-09-27T12:00:00.000Z";
const SESSION = "cs_test_abcdefgh";

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
    shippingDetails: null as StripeShippingDetails | null,
    customerEmail: null as string | null,
    customerPhone: null as string | null,
    prodigiKeyConfigured: false,
    now: NOW,
    ...overrides,
  };
}

function physicalMeta(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    photoSlug: "dawn",
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

const okCreate: CreateProdigiOrder = async () => ({
  ok: true,
  orderId: "ord_sandbox_1",
  stage: "InProgress",
  assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg",
});

test("parseOrderRecord rejects off-origin asset URLs even with safe paths", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const base = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: null,
    masterKey: null,
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: "buyer@example.com",
      phone: null,
    },
    prodigiOrderId: "ord_1",
    prodigiStage: "InProgress",
    updatedAt: NOW,
  };

  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://evil.example/placeholders/dawn.jpg",
      }),
    ),
    null,
  );
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://evil.example/api/print-asset?slug=dawn&exp=1&sig=ab",
      }),
    ),
    null,
  );

  const okPlaceholder = parseOrderRecord(
    JSON.stringify({
      ...base,
      assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg",
    }),
  );
  assert.ok(okPlaceholder);
  assert.equal(
    okPlaceholder.assetUrl,
    "https://nessebarlens.com/placeholders/dawn.jpg",
  );

  const okPrintAsset = parseOrderRecord(
    JSON.stringify({
      ...base,
      assetUrl:
        "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=" +
        "a".repeat(64),
    }),
  );
  assert.ok(okPrintAsset);
});

test("amounts are cents: merchandise for digital, merchandise plus shipping for physical", () => {
  assert.equal(SKU_MAP_READY, true);
  assert.equal(expectedAmountCents("digital", 30), 3000);
  assert.equal(expectedAmountCents("giclee", 15, 4.99), 1500 + 499);
  assert.equal(expectedAmountCents("framed", 13.48, 6), 1348 + 600);
});

test("parseRecipient requires a complete address", () => {
  assert.ok(parseRecipient(SHIPPING, "a@b.co", null));
  assert.equal(
    parseRecipient({ name: "x", address: { line1: "1", country: "BG" } }, null, null),
    null,
  );
});

test("digital payment with a matching total is paid and does not call Prodigi", async () => {
  let called = 0;
  const create: CreateProdigiOrder = async () => {
    called += 1;
    return { ok: true, orderId: "x", stage: null, assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg" };
  };
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput(),
    kv,
    createOrder: create,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.reason, null);
  assert.equal(called, 0);
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.masterKey, getPhoto("dawn")?.imageKey);
  assert.equal(stored.prodigiOrderId, null);
  assert.equal(stored.terminal, true);
  assert.equal(stored.format, "digital");
});

test("physical payment creates a Prodigi sandbox order and stores the id", async () => {
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 15 * 100 + 499,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: "buyer@example.com",
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: okCreate,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.prodigiOrderId, "ord_sandbox_1");
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.masterKey, null);
  assert.equal(stored.prodigiOrderId, "ord_sandbox_1");
  assert.equal(stored.prodigiStage, "InProgress");
  assert.equal(
    stored.assetUrl,
    "https://nessebarlens.com/placeholders/dawn.jpg",
  );
  assert.equal(stored.recipient?.countryCode, "BG");
  assert.equal(stored.recipient?.email, "buyer@example.com");
  assert.equal(JSON.stringify(stored).includes("prints/dawn.jpg"), false);
});

test("missing shipping is a permanent stop without calling Prodigi", async () => {
  let called = 0;
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: async () => {
      called += 1;
      return { ok: true, orderId: "x", stage: null, assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg" };
    },
  });
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "missing-shipping");
  assert.equal(called, 0);
});

test("a Prodigi 400 is terminal and stores its own reason", async () => {
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: async () => ({
      ok: false,
      kind: "client",
      reason: "prodigi-validation-error",
      message: "Prodigi order HTTP 400",
      status: 400,
    }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "prodigi-validation-error");
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.reason, "prodigi-validation-error");
  assert.equal(stored?.prodigiOrderId, null);
});

test("a retryable Prodigi failure writes the paid order, answers 500, and retries on redelivery", async () => {
  // The unrecoverable case this replaces: a wrong sandbox key used to be
  // terminal, so the customer paid, the record was written as a terminal
  // duplicate, the webhook answered 200, and every later delivery hit the
  // duplicate branch — also 200. Now the record is written non-terminal with
  // its own reason (so a human sees the paid-but-unfulfilled order and owns the
  // refund), the webhook answers 5xx, and a redelivery re-attempts Prodigi
  // instead of short-circuiting.
  for (const reason of [
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-asset-unconfigured",
    // A key that is not deployed yet is the same shape: retryable, and a
    // redelivery after the deploy places the order.
    "prodigi-unconfigured",
  ] as const) {
    const kv = memoryKv();
    let fail = true;
    const createOrder: CreateProdigiOrder = async () =>
      fail
        ? {
            ok: false,
            kind: "server",
            reason,
            message: "transient",
            status: null,
          }
        : { ok: true, orderId: "ord_fixed", stage: "InProgress", assetUrl: "https://nessebarlens.com/api/print-asset?x=1" };

    const first = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      kv,
      createOrder,
    });
    assert.equal(first.httpStatus, 500, reason);
    const stuck = parseOrderRecord((await kv.get(SESSION))!);
    assert.equal(stuck?.status, "paid-unfulfilled", reason);
    assert.equal(stuck?.reason, reason, reason);
    assert.equal(stuck?.terminal, false, reason);
    assert.equal(stuck?.prodigiOrderId, null, reason);

    // Stripe redelivers: the stored order is retried, not treated as a
    // duplicate, so fixing the key is what lands the print.
    fail = false;
    const retry = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      kv,
      createOrder,
    });
    assert.equal(retry.httpStatus, 200, reason);
    assert.equal(retry.body.duplicate, undefined, reason);
    const fixed = parseOrderRecord((await kv.get(SESSION))!);
    assert.equal(fixed?.status, "paid", reason);
    assert.equal(fixed?.prodigiOrderId, "ord_fixed", reason);
    assert.equal(fixed?.terminal, true, reason);

    // And a further redelivery of a now-terminal order is a plain duplicate:
    // Prodigi must not be asked to place a second order for one payment.
    const again = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      kv,
      createOrder,
    });
    assert.equal(again.body.duplicate, true, reason);
  }
});

test("a terminal Prodigi 400 is not retried on redelivery", async () => {
  const kv = memoryKv();
  let calls = 0;
  const createOrder: CreateProdigiOrder = async () => {
    calls += 1;
    return {
      ok: false,
      kind: "client",
      reason: "prodigi-validation-error",
      message: "Prodigi order HTTP 400",
      status: 400,
    };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder,
  });
  assert.equal(first.httpStatus, 200);
  const second = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder,
  });
  assert.equal(second.body.duplicate, true);
  assert.equal(calls, 1);
});

test("Prodigi server error returns 500 and records the paid order for a human", async () => {
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: async () => ({
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi order HTTP 503",
      status: 503,
    }),
  });
  assert.equal(result.httpStatus, 500);
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.reason, "prodigi-unavailable");
  assert.equal(stored?.terminal, false);
});

test("amount mismatch and missing shipping metadata are permanent stops", () => {
  const digitalWithShipping = decideFulfillment(
    paidInput({ amountTotal: 3000 + 1200 }),
  );
  assert.equal(digitalWithShipping.action, "write");
  if (digitalWithShipping.action === "write") {
    assert.equal(digitalWithShipping.record.reason, "amount-mismatch");
    assert.equal(digitalWithShipping.record.masterKey, null);
  }

  const physicalWithoutShippingMeta = decideFulfillment(
    paidInput({
      amountTotal: 1500,
      shippingDetails: SHIPPING,
      prodigiKeyConfigured: true,
      metadata: {
        photoSlug: "dawn",
        format: "framed",
        size: "30x40",
        frame: "black",
        quoteEur: "15",
        merchandiseEur: "15",
      },
    }),
  );
  assert.equal(physicalWithoutShippingMeta.action, "write");
  if (physicalWithoutShippingMeta.action === "write") {
    assert.equal(physicalWithoutShippingMeta.record.reason, "bad-metadata");
  }

  const physicalWrongTotal = decideFulfillment(
    paidInput({
      amountTotal: 1500,
      shippingDetails: SHIPPING,
      prodigiKeyConfigured: true,
      metadata: physicalMeta({
        format: "framed",
        frame: "black",
        sku: "GLOBAL-CFPM-12X16",
      }),
    }),
  );
  assert.equal(physicalWrongTotal.action, "write");
  if (physicalWrongTotal.action === "write") {
    assert.equal(physicalWrongTotal.record.reason, "amount-mismatch");
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

test("a second delivery does not overwrite the first ORDERS record or call Prodigi again", async () => {
  const kv = memoryKv();
  let calls = 0;
  const create: CreateProdigiOrder = async () => {
    calls += 1;
    return { ok: true, orderId: "ord_1", stage: "InProgress", assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg" };
  };
  await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: create,
  });
  const first = await kv.get(SESSION);
  const again = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: create,
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(kv.puts.length, 1);
  assert.equal(calls, 1);
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

  const physicalKv = memoryKv();
  await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta({ format: "canvas", sku: "GLOBAL-CAN-12X16" }),
    }),
    kv: physicalKv,
    createOrder: okCreate,
  });
  const physical = parseOrderRecord((await physicalKv.get(SESSION))!);
  assert.ok(physical);
  assert.equal(physical.format, "canvas");
  assert.equal(physical.status, "paid");
  const blocked = await resolveDownload(physical, {
    async get() {
      throw new Error("masters must not be read");
    },
  });
  assert.equal(blocked.kind, "json");
  if (blocked.kind === "json") assert.equal(blocked.status, 403);
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

test("webhook + download routes still do not call Prodigi; order module is the only fetch site", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const rel of [
    "src/lib/fulfillment.ts",
    "src/lib/master-key.ts",
    "src/lib/print-asset.ts",
    "src/lib/crypto-hex.ts",
    "src/lib/stripe-event.ts",
    "src/lib/worker-bindings.ts",
    "src/app/api/webhooks/stripe/route.ts",
    "src/app/api/download/route.ts",
    "src/app/api/print-asset/route.ts",
  ]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(src.includes("fetch("), false, rel);
    assert.equal(src.includes("api.sandbox.prodigi.com"), false, rel);
    assert.equal(src.includes("api.prodigi.com"), false, rel);
  }
  const order = fs.readFileSync(path.join(root, "src/lib/prodigi-order.ts"), "utf8");
  assert.equal(order.includes("prodigiOrdersUrl"), true);
  assert.equal(order.includes("prodigiApiKey"), true);
  assert.equal(order.includes("assertNoMasterLeak"), true);
  assert.equal(order.includes("signPrintAssetUrl"), true);
  const config = fs.readFileSync(
    path.join(root, "src/lib/prodigi-config.ts"),
    "utf8",
  );
  assert.equal(config.includes("https://api.sandbox.prodigi.com"), true);
  assert.equal(config.includes("https://api.prodigi.com"), true);
  assert.equal(masterKeyForSlug("dawn"), getPhoto("dawn")?.imageKey);
  assert.equal(masterKeyForSlug("not-a-photo"), null);
});

test("stripe client uses fetch http client for Workers", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/lib/stripe.ts"),
    "utf8",
  );
  assert.equal(src.includes("Stripe.createFetchHttpClient()"), true);
});

test("fulfillment metadata validation tracks the sku-map lists", () => {
  // Every combination the SKU table can build must pass metadata validation,
  // and anything outside the lists must be parked as bad-metadata.
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      for (const frame of format === "framed" ? FRAME_FINISHES : [""]) {
        const decided = decideFulfillment(
          paidInput({
            amountTotal: 1999,
            metadata: {
              photoSlug: "dawn",
              format,
              size,
              frame,
              quoteEur: "15",
              merchandiseEur: "15",
              shippingEur: "4.99",
              sku: "GLOBAL-FAP-12X16",
            },
            shippingDetails: SHIPPING,
          }),
        );
        assert.equal(decided.action, "write", `${format}/${size}/${frame}`);
        assert.notEqual(
          (decided as { record: OrderRecord }).record.reason,
          "bad-metadata",
        );
      }
    }
  }

  for (const size of ["99x99", "", "40x30"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: "dawn", format: "giclee", size, frame: "", quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `size ${size} should not be fulfillable`,
    );
  }

  for (const format of ["poster", "", "print"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: "dawn", format, size: "30x40", frame: "", quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `format ${format} should not be fulfillable`,
    );
  }

  for (const frame of ["gold", "silver"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: "dawn", format: "framed", size: "30x40", frame, quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `frame ${frame} should not be fulfillable`,
    );
  }
});

test("fulfillment reuses the pricing/sku-map types instead of redeclaring them", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/lib/fulfillment.ts"),
    "utf8",
  );
  // The union must be imported from pricing.ts, not restated here: a private
  // copy would leave the fulfillment validator behind when a format is added.
  // Either shape is fine as long as every one of the three unions is imported
  // from pricing.ts rather than restated here.
  const pricingImport = /import (type )?\{([^}]*)\} from "\.\/pricing"/.exec(src);
  assert.ok(pricingImport, "fulfillment must import from ./pricing");
  for (const name of ["FrameFinish", "PrintFormat", "PrintSize"]) {
    assert.ok(
      pricingImport[2]!.includes(name),
      `${name} must be imported from pricing.ts`,
    );
  }
  assert.equal(
    src.includes('export type PrintFormat = "giclee" | "framed" | "canvas" | "digital"'),
    false,
  );
  // No alias arrays re-wrapping the sku-map lists.
  assert.equal(/const SIZES\s*:/.test(src), false);
  assert.equal(/const FRAMES\s*:/.test(src), false);
  // The allow-list is read through sku-map's predicate, not through a local
  // alias array. The alias was not itself the bug -- it pointed at the shared
  // list -- but the two format guards each cast their way through it, so the
  // cast rather than the check decided what a stored format could be. Reading
  // isSellableFormat narrows once and cannot be pointed at a different list.
  assert.ok(
    src.includes("isSellableFormat"),
    "fulfillment must validate formats with sku-map's isSellableFormat",
  );
  assert.equal(
    /const FORMATS\s*:/.test(src),
    false,
    "no local alias of the sellable format list",
  );
  assert.equal(
    /as readonly string\[\]/.test(src),
    false,
    "no cast-through-string[] membership test in fulfillment",
  );
  // SELLABLE_FORMATS is the one place "digital" joins the physical formats.
  assert.equal(
    /\[\.\.\.PHYSICAL_FORMATS, "digital"\]/.test(src),
    false,
    'do not re-spell [...PHYSICAL_FORMATS, "digital"] in fulfillment',
  );
});


test("EUR→cents rounding is eurToCents everywhere, fractional inputs included", () => {
  // Stripe, the webhook amount check and the stored record all have to agree
  // on the rounding, or a paid session fails its own amount check.
  assert.equal(expectedAmountCents("digital", 15.005), eurToCents(15.005));
  assert.equal(expectedAmountCents("giclee", 15, 4.999), 1500 + 500);
  assert.equal(expectedAmountCents("canvas", 0.001, 0.001), 0);
  assert.equal(eurToCents(15.005), 1501);
});

test("parseOrderRecord accepts cent-exact amounts and rejects sub-cent ones", () => {
  const base = {
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
    assetUrl: null,
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const record = (patch: Record<string, unknown>) =>
    parseOrderRecord(JSON.stringify({ ...base, ...patch }));

  assert.equal(record({})?.quoteEur, 15);
  assert.equal(record({ quoteEur: 15.5 })?.quoteEur, 15.5);
  // 15.001 EUR is not a whole number of cents — Stripe would reject it.
  assert.equal(record({ quoteEur: 15.001 }), null);
  assert.equal(record({ quoteEur: -1 }), null);
  assert.equal(record({ quoteEur: Number.NaN }), null);
  assert.equal(record({ quoteEur: "15" }), null);
  assert.equal(record({ amountTotal: 1500.5 }), null);
});

test("resolveDownload is a gate, and every rejection path is distinguishable", async () => {
  const digitalPaid = (patch: Partial<OrderRecord> = {}): OrderRecord => {
    const base = (
      decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
    ).record;
    assert.equal(base.format, "digital");
    return { ...base, ...patch };
  };
  const bytes = (contentType?: string): MastersBucket => ({
    async get() {
      return { body: new ReadableStream(), size: 7, contentType };
    },
  });

  // 1. A physical order is not a download at all, and the bucket is untouched.
  let touched = false;
  const physical = digitalPaid({ format: "giclee" });
  const refused = await resolveDownload(physical, {
    async get() {
      touched = true;
      return null;
    },
  });
  assert.deepEqual(refused, {
    kind: "json",
    status: 403,
    body: { error: "not-a-digital-download" },
  });
  assert.equal(touched, false, "a physical order must never read MASTERS");

  // 2. Unfulfilled digital orders explain themselves with their stored reason.
  for (const reason of ["prodigi-error", "unfulfilled"] as const) {
    const unfulfilled = digitalPaid({ status: "paid-unfulfilled", reason, masterKey: null });
    const result = await resolveDownload(unfulfilled, undefined);
    assert.deepEqual(result, {
      kind: "json",
      status: 409,
      body: { error: "download-unavailable", reason },
    });
  }

  // 3. paid but masterKey null is still 409, not a 500 on a null key.
  const noKey = await resolveDownload(digitalPaid({ masterKey: null }), undefined);
  assert.equal(noKey.kind === "json" && noKey.status, 409);

  // 4. A throwing bucket is a 503 that does not escape.
  const throwing = await resolveDownload(digitalPaid(), {
    async get() {
      throw new Error("R2 down");
    },
  });
  assert.deepEqual(throwing, {
    kind: "json",
    status: 503,
    body: { error: "masters-unavailable" },
  });

  // 5. The filename comes from the slug, with a safe fallback if it is not one.
  const odd = digitalPaid({ photoSlug: "Not A Slug", masterKey: "prints/dawn.jpg" });
  const oddStream = await resolveDownload(odd, bytes("image/jpeg"));
  assert.equal(oddStream.kind === "stream" && oddStream.filename, "download.jpg");
  // contentType falls back to image/jpeg when the bucket does not say.
  const noType = await resolveDownload(digitalPaid(), bytes(undefined));
  assert.equal(noType.kind === "stream" && noType.contentType, "image/jpeg");
  const otherType = await resolveDownload(digitalPaid(), bytes("image/png"));
  assert.equal(otherType.kind === "stream" && otherType.contentType, "image/png");
});

test("the webhook ignores anything that is not a paid, well-formed session", async () => {
  // Not a Stripe session id at all.
  for (const sessionId of ["nope", "cs_123", "cs_test_", "cs_prod_12345678"]) {
    assert.deepEqual(decideFulfillment(paidInput({ sessionId })), {
      action: "ignore",
      reason: "invalid-session-id",
    });
  }
  // Right shape, not paid.
  for (const paymentStatus of ["unpaid", "no_payment_required", null, "PAID"]) {
    assert.deepEqual(decideFulfillment(paidInput({ paymentStatus })), {
      action: "ignore",
      reason: "unpaid",
    });
  }
  // The ignore decision is what the route answers with: 200 + received, so
  // Stripe stops retrying, and nothing is written.
  const kv = memoryKv();
  const ignored = await fulfillCheckoutSession({ ...paidInput({ sessionId: "nope" }), kv });
  assert.deepEqual(ignored, { httpStatus: 200, body: { received: true, ignored: "invalid-session-id" } });
  const unpaid = await fulfillCheckoutSession({ ...paidInput({ paymentStatus: "unpaid" }), kv });
  assert.deepEqual(unpaid, { httpStatus: 200, body: { received: true, ignored: "unpaid" } });
  assert.deepEqual(kv.puts, [], "an ignored session must not write ORDERS");
});

test("a non-framed format carrying a frame is bad metadata, not a silent drop", () => {
  for (const [format, frame] of [
    ["giclee", "black"],
    ["canvas", "brown"],
    ["giclee", " "],
  ] as const) {
    const decided = decideFulfillment(
      paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta({ format, frame }),
      }),
    );
    assert.equal(decided.action, "write");
    const record = (decided as { record: OrderRecord }).record;
    assert.equal(record.reason, "bad-metadata", `${format}/${frame}`);
    assert.equal(record.status, "paid-unfulfilled");
    assert.equal(record.recipient, null, "a rejected order keeps no shipping data");
  }
});

test("a physical order without shipping stops as missing-shipping, before Prodigi", async () => {
  const decided = decideFulfillment(
    paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
  );
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.reason, "missing-shipping");
  assert.equal(record.status, "paid-unfulfilled");

  let created = 0;
  const kv = memoryKv();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: async (input) => {
      created++;
      return okCreate(input);
    },
  });
  assert.equal(created, 0, "Prodigi must not be called for an unfulfillable order");
  assert.equal(result.httpStatus, 200);
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.reason, "missing-shipping");
});

test("parseOrderRecord rejects a stored recipient it cannot vouch for", () => {
  const shell = {
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
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const good = {
    ...shell,
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
  };
  assert.ok(parseOrderRecord(JSON.stringify(good)));
  for (const patch of [
    { email: 42 },
    { phone: {} },
    { countryCode: "bulgaria" },
    { countryCode: "B" },
    { city: 7 },
    { line1: null },
    { name: 1 },
    { state: 5 },
    { postcode: [] },
    { countryCode: null },
  ]) {
    const record = { ...good, recipient: { ...good.recipient, ...patch } };
    assert.equal(parseOrderRecord(JSON.stringify(record)), null, JSON.stringify(patch));
  }
  // A missing recipient field is not the same as a malformed one.
  const withoutLine2: Record<string, unknown> = { ...good.recipient };
  delete withoutLine2.line2;
  assert.equal(parseOrderRecord(JSON.stringify({ ...good, recipient: withoutLine2 })), null);
  assert.ok(parseOrderRecord(JSON.stringify({ ...good, recipient: null })));
});

test("a physical order with shipping but no Prodigi key waits, retryably, for the key", async () => {
  // This was the silent-money-losing case. The record was written with the
  // shell's terminal:true and the reason "prodigi-key-unset", so the webhook
  // answered 200, Stripe never redelivered, and a customer who paid for a print
  // got nothing — with no log line anywhere. A missing key is deploy config
  // and is fixable inside Stripe's redelivery window, so the order has to stay
  // eligible for a retry.
  const decided = decideFulfillment(
    paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: false,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
  );
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.reason, "prodigi-unconfigured");
  assert.equal(record.status, "paid-unfulfilled");
  assert.equal(record.terminal, false, "a redelivery must be able to retry it");
  // The address is kept: it is valid, only the credential is missing.
  assert.equal(record.recipient?.city, "Nessebar");

  let created = 0;
  const kv = memoryKv();
  // Stands in for the real client, which returns this exact failure without
  // contacting Prodigi (pinned in prodigi-order.test.mts).
  const unconfiguredCreate: CreateProdigiOrder = async () => {
    created++;
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unconfigured",
      message: "PRODIGI_SANDBOX_API_KEY is not set",
      status: null,
    };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: false,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: unconfiguredCreate,
  });
  assert.equal(created, 1);
  // Not a duplicate and not a success: 5xx, so Stripe keeps redelivering.
  assert.equal(first.httpStatus, 500);
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.reason, "prodigi-unconfigured");
  assert.equal(stored?.terminal, false);
  assert.equal(stored?.recipient?.city, "Nessebar");

  // The key is deployed; the redelivery places the order. One payment, one
  // Prodigi order — and the same session id is the idempotency key, so even if
  // Prodigi had already accepted the first POST it returns that same order.
  const second = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    kv,
    createOrder: okCreate,
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.duplicate, undefined);
  const placed = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(placed?.status, "paid");
  assert.equal(placed?.prodigiOrderId, "ord_sandbox_1");
  assert.equal(placed?.terminal, true);
});

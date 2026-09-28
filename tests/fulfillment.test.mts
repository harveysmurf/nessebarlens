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

test("Prodigi client error becomes paid-unfulfilled prodigi-error", async () => {
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
      message: "Prodigi order HTTP 400",
      status: 400,
    }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "prodigi-error");
  const stored = parseOrderRecord((await kv.get(SESSION))!);
  assert.equal(stored?.reason, "prodigi-error");
  assert.equal(stored?.prodigiOrderId, null);
});

test("Prodigi server error returns 500 and does not write ORDERS", async () => {
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
      message: "Prodigi order HTTP 503",
      status: 503,
    }),
  });
  assert.equal(result.httpStatus, 500);
  assert.equal(await kv.get(SESSION), null);
  assert.equal(kv.puts.length, 0);
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

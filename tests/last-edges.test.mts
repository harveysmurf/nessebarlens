import assert from "node:assert/strict";
import test from "node:test";
import { fulfillCheckoutSession } from "../src/application/fulfillment/fulfillment.ts";
import type { OrdersStore } from "../src/domain/ordering/orders-store.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import {
  parseRecipient,
  type StripeShippingDetails,
} from "../src/domain/ordering/order-decision.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";
import type { AssetUrlSigner } from "../src/domain/ordering/asset-url-signer.ts";
import { ConfiguredAssetUrlSigner } from "../src/infrastructure/print-asset/asset-url-signer.ts";
import { createProdigiOrder } from "../src/infrastructure/prodigi/prodigi-order.ts";

const SITE_URL = "https://nessebarlens.com";
const ASSET_URL = `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`;
const okSigner: AssetUrlSigner = {
  sign: async () => ASSET_URL,
  verify: async () => ({ ok: true, slug: SAMPLE_SLUG }),
};

/* The last edges the report could still name. Each is a branch production takes
   and no test had: an address Stripe can send without a country, a framed
   physical order, and the real Prodigi client behind the default injection
   point. */

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

/** An empty in-memory OrdersStore: every case here starts from no record. */
function emptyStore(): OrdersStore {
  return memoryOrdersStore();
}

function physicalInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
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
    shippingDetails: SHIPPING,
    customerEmail: "buyer@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: NOW,
    ...overrides,
  };
}

test("an address with no country is not a recipient", () => {
  // Stripe's schema makes country optional, so a digital-customer address can
  // arrive without one. The empty fallback must fail the two-letter check
  // rather than produce a recipient with an empty countryCode, which Prodigi
  // would reject as a bad address and the webhook would then retry forever.
  const parsed = parseRecipient(
    { name: "Test Buyer", address: { ...SHIPPING.address, country: undefined } },
    null,
  );
  assert.equal(parsed, null);
  // Present and valid, so the check is the country and not the address.
  assert.ok(parseRecipient(SHIPPING, null));
});

test("a framed physical order keeps the frame finish all the way to Prodigi", async () => {
  let seen: Record<string, unknown> | null = null;
  const result = await fulfillCheckoutSession({
    ...physicalInput({ metadata: {
        photoSlug: SAMPLE_SLUG,
        format: "framed",
        size: "30x40",
        frame: "black",
        quoteEur: "15",
        merchandiseEur: "15",
        shippingEur: "4.99",
        sku: "GLOBAL-FAP-12X16",
      } }),
    store: emptyStore(),
    assetUrlSigner: okSigner,
    siteUrl: SITE_URL,
    async createOrder(input) {
      seen = input as unknown as Record<string, unknown>;
      return {
        ok: true,
        value: {
          orderId: "ord_framed_1",
          stage: null,
          assetUrl: `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`,
        },
      };
    },
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(seen?.frame, "black", "the frame finish is passed through");
  assert.equal(result.body.status, "paid");
});

test("a physical order whose shipping quote is missing is bad-metadata, not a mismatch", async () => {
  // The expected total is merchandise + shipping, so without the shipping quote
  // there is no total to verify. It stops here rather than comparing against
  // merchandise + 0, which would blame the customer for a tampered amount when
  // the real problem is incomplete metadata.
  const result = await fulfillCheckoutSession({
    ...physicalInput({
      amountTotal: 1500,
      metadata: {
        photoSlug: SAMPLE_SLUG,
        format: "giclee",
        size: "30x40",
        frame: "",
        quoteEur: "15",
        merchandiseEur: "15",
      },
    }),
    store: emptyStore(),
    assetUrlSigner: okSigner,
    siteUrl: SITE_URL,
    async createOrder() {
      throw new Error("Prodigi must not be called without a shipping quote");
    },
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "bad-metadata");
});

test("the real Prodigi client is what runs when no order factory is injected", async () => {
  // Every other physical test injects a fake, so the default arm — the actual
  // createProdigiOrder that the webhook calls in production — had never run.
  // Driven here with a stubbed fetch, so the request is inspected rather than
  // sent and the env is what a configured sandbox deployment has.
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  // The order path now fails closed when the master cannot be signed, so this
  // needs a usable secret to reach the real client at all.
  process.env.PRINT_ASSET_HMAC_SECRET = "last-edges-hmac-secret-32-chars!!";
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        order: { id: "ord_real_1", status: { stage: "awaiting-production" } },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await fulfillCheckoutSession({
      ...physicalInput(),
      store: emptyStore(),
      createOrder: createProdigiOrder,
      assetUrlSigner: new ConfiguredAssetUrlSigner(),
      siteUrl: SITE_URL,
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.status, "paid");
    assert.equal(requests.length, 1, "one sandbox order was created");
    assert.match(requests[0].url, /api\.sandbox\.prodigi\.com/);
    const body = requests[0].body as { merchantReference: string };
    assert.equal(body.merchantReference, SESSION);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      "PRODIGI_API_BASE",
      "PRODIGI_SANDBOX_API_KEY",
      "NEXT_PUBLIC_SITE_URL",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

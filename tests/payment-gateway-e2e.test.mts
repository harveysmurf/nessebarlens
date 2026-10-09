/**
 * End-to-end through the ports (#3, DDD acceptance).
 *
 * A fake `PaymentGateway` produces a domain `PaymentEvent` and a fake
 * `PrintProvider` places the order, with `fulfillCheckoutSession` in between.
 * This is the point of the ports: the application drives the same path with no
 * Stripe SDK and no Prodigi HTTP, so the seam is real and substitutable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";
import {
  fulfillmentInputFromSession,
  type CheckoutIntent,
  type PaymentCheckoutSession,
  type PaymentEvent,
  type PaymentGateway,
} from "../src/application/checkout/payment-gateway.ts";
import type {
  CreateProdigiOrder,
  PrintProvider,
} from "../src/domain/ordering/print-provider.ts";
import type { AssetUrlSigner } from "../src/domain/ordering/asset-url-signer.ts";
import { parseOrderRecord } from "../src/domain/ordering/order-decision.ts";
import { fulfillCheckoutSession } from "../src/application/fulfillment/fulfillment.ts";
import { PRINT_PRODUCTS } from "../src/domain/pricing/print-products.ts";
import {
  resolveSku,
  type PhysicalFormat,
} from "../src/domain/pricing/sku-map.ts";

const SESSION = "cs_test_fakegateway01";
const NOW = "2026-10-08T12:00:00.000Z";
const SITE_URL = "https://nessebarlens.com";
process.env.NEXT_PUBLIC_SITE_URL = SITE_URL;

const okSigner: AssetUrlSigner = {
  sign: async () => `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`,
  verify: async () => ({ ok: true, slug: SAMPLE_SLUG }),
};

test("a fake gateway + fake print provider drive a physical order end to end", async () => {
  let createdIntent: CheckoutIntent | null = null;
  const gateway: PaymentGateway = {
    async createCheckout(intent) {
      createdIntent = intent;
      return {
        ok: true,
        value: { url: "https://checkout.stripe.com/c/pay/fake", sessionId: SESSION },
      };
    },
    async verifyAndParseWebhook({ rawBody }) {
      return { ok: true, event: JSON.parse(rawBody) as PaymentEvent };
    },
  };

  const placed: Array<{ photoSlug: string; sessionId: string }> = [];
  const printProvider: PrintProvider = {
    async quote() {
      return {
        ok: true,
        value: {
          sku: "GLOBAL-FAP-12X16",
          unitCostEur: 10,
          shippingEur: 4.99,
          merchandiseEur: 15,
        },
      };
    },
    async placeOrder(input) {
      placed.push({ photoSlug: input.photoSlug, sessionId: input.sessionId });
      return {
        ok: true,
        value: {
          orderId: "ord_fake_1",
          stage: "InProgress",
          assetUrl: "https://nessebarlens.com/api/print-asset?token=fake",
        },
      };
    },
  };

  // 1. The checkout intent reaches the gateway.
  const checkout = await gateway.createCheckout({
    title: "Old Nessebar",
    format: "giclee",
    size: "30x40",
    frame: null,
    previewImage: null,
    quoteEur: 15,
    shippingEur: 4.99,
    destinationCountryCode: "BG",
    successUrl: "https://nessebarlens.com/ok",
    cancelUrl: "https://nessebarlens.com/cancel",
    metadata: {},
  });
  assert.equal(checkout.ok, true);
  if (checkout.ok) assert.equal(checkout.value.sessionId, SESSION);
  assert.equal(createdIntent?.format, "giclee");

  // 2. A provider event arrives; the fake gateway emits a domain event.
  const session: PaymentCheckoutSession = {
    id: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "30x40",
      frame: "",
      quoteEur: "15",
      shippingEur: "4.99",
      sku: "GLOBAL-FAP-12X16",
      destinationCountryCode: "BG",
    },
    shippingDetails: null,
    collectedShippingDetails: {
      name: "Test Buyer",
      address: {
        line1: "1 Harbor St",
        line2: null,
        city: "Nessebar",
        state: null,
        postal_code: "8230",
        country: "BG",
      },
    },
    customerEmail: "buyer@example.com",
    customerPhone: null,
    successUrl: `https://nessebarlens.com/checkout/success?session_id=${SESSION}`,
  };
  const event: PaymentEvent = {
    kind: "checkout-session",
    type: "checkout.session.completed",
    session,
  };
  const verified = await gateway.verifyAndParseWebhook({
    rawBody: JSON.stringify(event),
    signature: "not-checked-by-the-fake",
    secret: "not-checked-by-the-fake",
  });
  assert.equal(verified.ok, true);
  if (!verified.ok || verified.event.kind !== "checkout-session") {
    assert.fail("expected a checkout-session event");
  }

  // 3. Fulfillment consumes the event and the fake print provider places it.
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...fulfillmentInputFromSession(verified.event.session),
    store,
    prodigiKeyConfigured: true,
    now: NOW,
    createOrder: printProvider.placeOrder,
    assetUrlSigner: okSigner,
    siteUrl: SITE_URL,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.deepEqual(placed, [{ photoSlug: SAMPLE_SLUG, sessionId: SESSION }]);

  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.prodigiOrderId, "ord_fake_1");
});

/** The attributes each format's order carries, independent of the table. */
const EXPECTED_ATTRIBUTES: Record<PhysicalFormat, Record<string, string>> = {
  giclee: {},
  framed: { color: "black" },
  canvas: { wrap: "ImageWrap" },
};

test("every physical product reaches the print provider with its table SKU", async () => {
  // #296: the table is the single source, so a fake-gateway session for each
  // product must reach the PrintProvider port carrying the pair — and the pair
  // must resolve to the table's SKU and attributes, not a hand-typed one.
  for (const product of PRINT_PRODUCTS) {
    const frame = product.format === "framed" ? "black" : null;
    const seen: Array<Parameters<CreateProdigiOrder>[0]> = [];
    const printProvider: PrintProvider = {
      async quote() {
        return {
          ok: true,
          value: {
            sku: product.sku,
            unitCostEur: 10,
            shippingEur: 4.99,
            merchandiseEur: 15,
          },
        };
      },
      async placeOrder(input) {
        seen.push(input);
        return {
          ok: true,
          value: {
            orderId: `ord_${product.sku}`,
            stage: "InProgress",
            assetUrl: input.assetUrl,
          },
        };
      },
    };

    const sessionId = `cs_test_${product.sku.toLowerCase().replaceAll("-", "")}`;
    const session: PaymentCheckoutSession = {
      id: sessionId,
      paymentStatus: "paid",
      currency: "eur",
      amountTotal: 1999,
      metadata: {
        photoSlug: SAMPLE_SLUG,
        format: product.format,
        size: product.size,
        frame: frame ?? "",
        quoteEur: "15",
        shippingEur: "4.99",
        sku: product.sku,
        destinationCountryCode: "BG",
      },
      shippingDetails: null,
      collectedShippingDetails: {
        name: "Test Buyer",
        address: {
          line1: "1 Harbor St",
          line2: null,
          city: "Nessebar",
          state: null,
          postal_code: "8230",
          country: "BG",
        },
      },
      customerEmail: "buyer@example.com",
      customerPhone: null,
      successUrl: `https://nessebarlens.com/checkout/success?session_id=${sessionId}`,
    };

    const store = memoryOrdersStore();
    const result = await fulfillCheckoutSession({
      ...fulfillmentInputFromSession(session),
      store,
      prodigiKeyConfigured: true,
      now: NOW,
      createOrder: printProvider.placeOrder,
      assetUrlSigner: okSigner,
      siteUrl: SITE_URL,
    });
    assert.equal(result.httpStatus, 200, product.sku);
    assert.equal(seen.length, 1, `${product.sku} placed once`);
    assert.equal(seen[0]!.format, product.format, product.sku);
    assert.equal(seen[0]!.size, product.size, product.sku);
    assert.equal(seen[0]!.frame, frame, product.sku);

    const entry = resolveSku(product.format, product.size, frame);
    assert.equal(entry.sku, product.sku);
    assert.deepEqual(entry.attributes, EXPECTED_ATTRIBUTES[product.format]);
  }
});

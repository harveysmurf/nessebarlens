/**
 * A physical order must never be paid for without a postcode (#195).
 *
 * Stripe's hosted BG address form treats the postal code as optional, so a
 * session completed with `address.postal_code = ""` was paid for and could never
 * reach Prodigi (`MustNotBeEmptyOrWhitespace`). These tests pin the three
 * things that close it: the required Checkout custom field, the fallback in
 * `parseRecipient`, and the per-country format check that turns a typo into a
 * local rejection instead of a Prodigi error after the money is taken.
 *
 * They also pin the second half of the issue: an operator alert on every
 * paid-unfulfilled outcome, once per transition and not on a redelivery.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { fulfillCheckoutSession } from "../src/lib/fulfillment.ts";
import {
  parseRecipient,
  type StripeShippingDetails,
} from "../src/lib/order-decision.ts";
import {
  POSTCODE_CUSTOM_FIELD,
  POSTCODE_CUSTOM_FIELD_KEY,
  isValidPostcode,
  postcodeCustomFields,
  postcodeFromCustomFields,
} from "../src/lib/postcode.ts";
import { OPS_ALERT_TO, type SendEmail } from "../src/lib/email.ts";
import { emailCopyFor } from "../src/lib/email-copy.ts";
import type { CreateProdigiOrder } from "../src/lib/prodigi-order.ts";

const SESSION = "cs_test_abcdefgh";
const NOW = "2026-09-27T12:00:00.000Z";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

/** A complete BG address with the postal code blank, as Stripe sends it. */
const BLANK_POSTCODE: StripeShippingDetails = {
  name: "Test Buyer",
  address: {
    line1: "1 Harbor St",
    line2: "",
    city: "Nessebar",
    state: "",
    postal_code: "",
    country: "BG",
  },
};

const WITH_POSTCODE: StripeShippingDetails = {
  ...BLANK_POSTCODE,
  address: { ...BLANK_POSTCODE.address, postal_code: "8230" },
};

function physicalMeta(extra: Record<string, string> = {}): Record<string, string> {
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

test("the physical session carries a required postcode field", () => {
  const [field] = postcodeCustomFields(true);
  assert.equal(field.key, POSTCODE_CUSTOM_FIELD_KEY);
  // The whole point: Stripe refuses to complete a session without it.
  assert.equal(field.optional, false);
  assert.equal(field.type, "text");
  // A digital session gets no field list — an optional definition is rejected
  // by Stripe, so an empty array is the only correct "no field" value.
  assert.deepEqual(postcodeCustomFields(false), []);
  assert.equal(POSTCODE_CUSTOM_FIELD.label, "Postcode");
});

test("a blank Stripe postcode plus the custom field is a valid recipient", () => {
  const parsed = parseRecipient(
    BLANK_POSTCODE,
    "buyer@example.com",
    null,
    " 8230 ",
  );
  assert.equal(parsed?.postcode, "8230");
  assert.equal(parsed?.countryCode, "BG");
});

test("both postcodes blank is still missing-shipping, unchanged", () => {
  assert.equal(parseRecipient(BLANK_POSTCODE, "a@b.co", null, null), null);
  assert.equal(parseRecipient(BLANK_POSTCODE, "a@b.co", null, "   "), null);
});

test("the address wins over the custom field when both have a value", () => {
  // Stripe validated the address against the locked destination country, so
  // that is the value Prodigi must get even if the two disagree.
  const parsed = parseRecipient(
    WITH_POSTCODE,
    "a@b.co",
    null,
    "9999",
  );
  assert.equal(parsed?.postcode, "8230");
});

test("a malformed BG postcode is rejected before Prodigi sees it", () => {
  // 3 digits, 5 digits and letters are all things a customer types by mistake;
  // each is a `Required`-shaped rejection at Prodigi, after payment.
  assert.equal(parseRecipient(BLANK_POSTCODE, "a@b.co", null, "823"), null);
  assert.equal(parseRecipient(BLANK_POSTCODE, "a@b.co", null, "82300"), null);
  assert.equal(parseRecipient(BLANK_POSTCODE, "a@b.co", null, "82 3o"), null);
});

test("a well-formed postcode of another shape is not rejected on a guess", () => {
  // We only know BG's grammar for certain. Refusing a valid address for a
  // country we have no pattern for is the worse failure for a paid order.
  assert.equal(isValidPostcode("GB", "SW1A 1AA"), true);
  assert.equal(isValidPostcode("DE", "10115"), true);
  assert.equal(isValidPostcode("BG", "8230"), true);
  assert.equal(isValidPostcode("bg", "8230"), true);
  assert.equal(isValidPostcode("BG", "823O"), false);
});

test("the custom field is read defensively off an untrusted array", () => {
  assert.equal(
    postcodeFromCustomFields([
      { key: "gift_note", text: { value: "hi" } },
      { key: POSTCODE_CUSTOM_FIELD_KEY, text: { value: " 8230 " } },
    ]),
    "8230",
  );
  assert.equal(
    postcodeFromCustomFields([{ key: POSTCODE_CUSTOM_FIELD_KEY, text: null }]),
    null,
  );
  assert.equal(
    postcodeFromCustomFields([{ key: POSTCODE_CUSTOM_FIELD_KEY, text: { value: "  " } }]),
    null,
  );
  // A malformed payload falls through to parseRecipient's rejection; it never
  // throws on a paid webhook.
  assert.equal(postcodeFromCustomFields(null), null);
  assert.equal(postcodeFromCustomFields("nope"), null);
  assert.equal(postcodeFromCustomFields([null, 3, "x"]), null);
});

test("the webhook passes the custom field through to parseRecipient", async () => {
  const calls: CreateProdigiOrder[] = [];
  await fulfillCheckoutSession({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
    metadata: physicalMeta(),
    shippingDetails: BLANK_POSTCODE,
    customPostcode: "8230",
    customerEmail: "buyer@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: NOW,
    store: memoryOrdersStore(),
    createOrder: async (order) => {
      calls.push(order);
      return {
        ok: true,
        value: {
          orderId: "ord_1",
          stage: "in-production",
          assetUrl: "https://api.prodigi.com/asset.png",
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient?.postcode, "8230");
});

test("the reconciler reads the same custom field off its session shape", async () => {
  // The reconciler rebuilds the same session shape as the webhook, so a fix
  // that only touched the webhook would leave a recovered order with no
  // postcode. Driven through the `missed` path — a paid session no record
  // exists for — because that is the path where the session's own address is
  // what decides whether the order can reach Prodigi at all.
  const { reconcileOrders } = await import("../src/lib/reconcile.ts");
  const calls: CreateProdigiOrder[] = [];
  const session = {
    id: SESSION,
    payment_status: "paid",
    currency: "eur",
    amount_total: 1999,
    metadata: physicalMeta(),
    shipping_details: BLANK_POSTCODE,
    custom_fields: [{ key: POSTCODE_CUSTOM_FIELD_KEY, text: { value: "8230" } }],
    customer_details: { email: "buyer@example.com", phone: null },
  };
  const summary = await reconcileOrders({
    store: memoryOrdersStore(),
    nowMs: Date.parse(NOW),
    prodigiKeyConfigured: true,
    createOrder: async (order) => {
      calls.push(order);
      return {
        ok: true,
        value: {
          orderId: "ord_2",
          stage: "in-production",
          assetUrl: "https://api.prodigi.com/asset.png",
        },
      };
    },
    stripe: {
      retrieveCheckoutSession: async () => null,
      listPaidCheckoutSessions: async () => [session],
    },
  });
  assert.equal(summary.missed, 1);
  assert.equal(summary.recovered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient?.postcode, "8230");
});

test("the reconciler leaves a session with no postcode anywhere unfulfilled", async () => {
  // The same session without the custom field is the bug the issue reports:
  // paid, and no address Prodigi will accept. The reconciler must not invent a
  // recipient for it.
  const { reconcileOrders } = await import("../src/lib/reconcile.ts");
  const calls: CreateProdigiOrder[] = [];
  const summary = await reconcileOrders({
    store: memoryOrdersStore(),
    nowMs: Date.parse(NOW),
    prodigiKeyConfigured: true,
    createOrder: async (order) => {
      calls.push(order);
      return {
        ok: true,
        value: {
          orderId: "ord_6",
          stage: "in-production",
          assetUrl: "https://api.prodigi.com/asset.png",
        },
      };
    },
    stripe: {
      retrieveCheckoutSession: async () => null,
      listPaidCheckoutSessions: async () => [
        {
          id: SESSION,
          payment_status: "paid",
          currency: "eur",
          amount_total: 1999,
          metadata: physicalMeta(),
          shipping_details: BLANK_POSTCODE,
          customer_details: { email: "buyer@example.com", phone: null },
        },
      ],
    },
  });
  assert.equal(summary.recovered, 1);
  assert.equal(calls.length, 0);
});

function recordingSender(): {
  sender: SendEmail;
  sent: Array<{ to: string; kind: string; subject: string; text: string }>;
} {
  const sent: Array<{ to: string; kind: string; subject: string; text: string }> =
    [];
  const sender: SendEmail = async (mail) => {
    sent.push({
      to: mail.to,
      kind: mail.kind,
      subject: mail.subject,
      text: mail.text,
    });
    return { ok: true, message: "sent" };
  };
  return { sender, sent };
}

test("every paid-unfulfilled order alerts the operator, once", async () => {
  // missing-shipping: the exact order from the issue — paid, no postcode
  // anywhere, so Prodigi can never be reached.
  const { sender, sent } = recordingSender();
  const store = memoryOrdersStore();
  await fulfillCheckoutSession({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
    metadata: physicalMeta(),
    shippingDetails: BLANK_POSTCODE,
    customerEmail: "buyer@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: NOW,
    store,
    sendEmail: sender,
    createOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_3",
        stage: "in-production",
        assetUrl: "https://api.prodigi.com/asset.png",
      },
    }),
  });

  const alerts = sent.filter((m) => m.kind === "order-ops-alert");
  assert.equal(alerts.length, 1, "exactly one operator alert");
  assert.equal(alerts[0].to, OPS_ALERT_TO);
  assert.match(alerts[0].text, /missing-shipping/);
  assert.match(alerts[0].text, new RegExp(SESSION));
  // The customer still gets their apology.
  assert.equal(
    sent.filter((m) => m.kind === "order-unfulfilled").length,
    1,
  );
});

test("a redelivery of the same unfulfilled order sends no second alert", async () => {
  const { sender, sent } = recordingSender();
  const store = memoryOrdersStore();
  const input = {
    sessionId: SESSION,
    paymentStatus: "paid" as const,
    currency: "eur" as const,
    amountTotal: 1999,
    metadata: physicalMeta(),
    shippingDetails: BLANK_POSTCODE,
    customerEmail: "buyer@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: NOW,
    store,
    sendEmail: sender,
    createOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_4",
        stage: "in-production",
        assetUrl: "https://api.prodigi.com/asset.png",
      },
    }),
  };
  const first = await fulfillCheckoutSession(input);
  const second = await fulfillCheckoutSession(input);
  assert.equal(first.body.status, "paid-unfulfilled");
  assert.equal(second.body.duplicate, true);
  assert.equal(
    sent.filter((m) => m.kind === "order-ops-alert").length,
    1,
  );
});

test("a fulfilled order sends no operator alert", async () => {
  const { sender, sent } = recordingSender();
  await fulfillCheckoutSession({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1999,
    metadata: physicalMeta(),
    shippingDetails: WITH_POSTCODE,
    customPostcode: null,
    customerEmail: "buyer@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: NOW,
    store: memoryOrdersStore(),
    sendEmail: sender,
    createOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_5",
        stage: "in-production",
        assetUrl: "https://api.prodigi.com/asset.png",
      },
    }),
  });
  assert.equal(sent.filter((m) => m.kind === "order-ops-alert").length, 0);
  assert.equal(sent.filter((m) => m.kind === "order-confirmation").length, 1);
});

test("operator alert copy names the reason and how to inspect the order", () => {
  const copy = emailCopyFor({
    kind: "order-ops-alert",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    opsDetail: "reason=missing-shipping terminal=true format=giclee",
  });
  assert.match(copy.subject, /ACTION/);
  assert.match(copy.text, /reason=missing-shipping/);
  assert.match(copy.text, /npm run orders/);
});

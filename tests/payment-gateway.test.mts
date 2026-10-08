/**
 * The Stripe adapter's reconciler read and the composition root (#3, DDD).
 *
 * The gateway port itself is exercised through the checkout and webhook route
 * tests; what those never reach is the reconciler's session read, which the
 * unloaded reconcile route drives. This test pins it against a stubbed fetch —
 * the same seam order-revocation uses for its lookup — so the adapter's
 * retrieve/list/to-domain mapping is real, not assumed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { paymentGateway, reconcileStripe } from "../src/lib/container.ts";
import { hmacSha256Hex } from "../src/lib/crypto-hex.ts";

function withStripeKey(): { restore: () => void } {
  const saved = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_reconcile_adapter";
  return {
    restore() {
      if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = saved;
    },
  };
}

function withFetch(
  handler: (url: string, init?: RequestInit) => Response,
): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("reconcileStripe maps a retrieved session to the domain shape", async () => {
  const key = withStripeKey();
  const seen: string[] = [];
  const fetchStub = withFetch((url) => {
    seen.push(url);
    return new Response(
      JSON.stringify({
        id: "cs_test_reconcile",
        payment_status: null,
        currency: "eur",
        amount_total: 1999,
        metadata: { photoSlug: "sample" },
        success_url: "https://nessebarlens.com/checkout/success",
        shipping_details: {
          name: "Buyer",
          address: { line1: "1 St", city: "Nessebar", postal_code: "8230", country: "BG" },
        },
        customer_details: { email: "buyer@example.com", phone: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const stripe = reconcileStripe();
    const session = await stripe.retrieveCheckoutSession("cs_test_reconcile");
    assert.equal(session?.id, "cs_test_reconcile");
    assert.equal(session?.payment_status, null);
    assert.equal(session?.amount_total, 1999);
    assert.equal(session?.shipping_details?.address?.country, "BG");
    assert.equal(session?.customer_details?.email, "buyer@example.com");
    assert.ok(seen.some((url) => url.includes("/checkout/sessions/cs_test_reconcile")));
  } finally {
    fetchStub.restore();
    key.restore();
  }
});

test("reconcileStripe lists only paid sessions", async () => {
  const key = withStripeKey();
  const fetchStub = withFetch(
    () =>
      new Response(
        JSON.stringify({
          object: "list",
          has_more: false,
          data: [
            { id: "cs_paid", payment_status: "paid" },
            { id: "cs_unpaid", payment_status: "unpaid" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const stripe = reconcileStripe();
    const paid = await stripe.listPaidCheckoutSessions({
      createdGte: 0,
      limit: 10,
    });
    assert.deepEqual(
      paid.map((session) => session.id),
      ["cs_paid"],
    );
  } finally {
    fetchStub.restore();
    key.restore();
  }
});

test("a dispute with an expanded charge maps to no charge id", async () => {
  const secret = "whsec_test_gateway_adapter";
  const payload = JSON.stringify({
    id: "evt_dispute_object",
    object: "event",
    type: "charge.dispute.created",
    data: {
      object: { id: "dp_1", object: "dispute", charge: { id: "ch_1" } },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
  const result = await paymentGateway().verifyAndParseWebhook({
    rawBody: payload,
    signature: `t=${timestamp},v1=${digest}`,
    secret,
  });
  assert.equal(result.ok, true);
  if (result.ok && result.event.kind === "dispute-created") {
    assert.equal(result.event.dispute.charge, null);
  } else {
    assert.fail("expected a dispute-created event");
  }
});

test("reconcileStripe returns null when a retrieve fails", async () => {
  const key = withStripeKey();
  const fetchStub = withFetch(
    () =>
      new Response(JSON.stringify({ error: { type: "api_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const stripe = reconcileStripe();
    assert.equal(await stripe.retrieveCheckoutSession("cs_test_missing"), null);
  } finally {
    fetchStub.restore();
    key.restore();
  }
});

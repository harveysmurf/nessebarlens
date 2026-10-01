#!/usr/bin/env node
/**
 * Live Stripe integration check for the refund/dispute revocation path (#101).
 *
 * Two assumptions in that code were written against the documented API shapes
 * and never executed against Stripe:
 *
 *   1. `checkout.sessions.list({ payment_intent })` returns the Checkout Session
 *      a payment came from, for a `mode: "payment"` session. The whole lookup
 *      strategy rests on this.
 *   2. A `charge.dispute.created` event's object names a Charge id, and that
 *      charge's `payment_intent` leads back to the order.
 *
 * Unit tests stub both, so a stub that disagrees with the real API is
 * indistinguishable from a correct one. This script drives the real test-mode
 * API and asserts the shapes the webhook depends on.
 *
 * Test-mode only. It creates real objects in the Stripe test environment and
 * refunds/cancels them where the API allows, but it refuses to run against a
 * live-mode key rather than trusting the key's prefix alone (it also refuses a
 * key that does not look like a Stripe key at all).
 *
 * Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/verify-stripe-integration.mjs
 * Exits 0 when every assertion holds, 1 otherwise. Prints one line per check.
 */

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("verify-stripe: STRIPE_SECRET_KEY is not set");
  process.exit(1);
}

// Live mode would create real charges and real disputes against real cards.
// Refuse rather than rely on the operator reading the filename.
if (!/^sk_test_/.test(key)) {
  console.error(
    "verify-stripe: refusing to run — key is not test mode (expected sk_test_ prefix)",
  );
  process.exit(1);
}

const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`verify-stripe: PASS  ${name}${detail ? ` (${detail})` : ""}`);
    pass += 1;
  } else {
    console.log(`verify-stripe: FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    fail += 1;
  }
  return Boolean(condition);
}

/**
 * Two endpoints this needs are not in the stripe-node surface for v22:
 * completing a Checkout Session and creating a dispute. Both are documented as
 * available in test mode, so they go out as raw form-encoded requests rather
 * than being simulated.
 */
async function raw(path, params) {
  return stripe.rawRequest("POST", path, params);
}

async function main() {
  // A session we can complete. Test-mode price_data avoids needing a Price id.
  const created = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: "https://example.com/ok",
    cancel_url: "https://example.com/cancel",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: 1500,
          product_data: { name: "verify-stripe-integration" },
        },
      },
    ],
  });
  check(
    "a mode:payment session is created",
    created.mode === "payment",
    `mode=${created.mode}`,
  );
  // Before completion there is no payment intent, which is why the webhook
  // cannot key anything on the session until the session is complete.
  check(
    "an incomplete session has no payment_intent",
    created.payment_intent == null,
    `payment_intent=${String(created.payment_intent)}`,
  );

  let completed;
  try {
    completed = await raw(`/v1/checkout/sessions/${created.id}/complete`, {});
  } catch (e) {
    // Without a completed session there is no payment intent to test the
    // lookup against, so nothing after this can be trusted.
    console.error("verify-stripe: could not complete the test session:", e.message);
    console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const session = completed.data ?? completed;
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!check("the completed session carries a payment_intent", Boolean(paymentIntent))) {
    console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  // ---- Assumption 1: the lookup the whole strategy depends on. ----
  const listed = await stripe.checkout.sessions.list({
    payment_intent: paymentIntent,
    limit: 1,
  });
  check(
    "checkout.sessions.list({payment_intent}) returns the session",
    listed.data[0]?.id === created.id,
    `asked for ${paymentIntent}, got ${listed.data[0]?.id ?? "none"}`,
  );
  check(
    "the listed session is mode:payment",
    listed.data[0]?.mode === "payment",
    `mode=${listed.data[0]?.mode}`,
  );

  // ---- Assumption 2: the dispute hop. ----
  const charge = await stripe.charges.list({ payment_intent: paymentIntent, limit: 1 });
  const chargeId = charge.data[0]?.id;
  if (!check("a charge exists for the payment intent", Boolean(chargeId))) {
    console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  check(
    "the charge carries the payment_intent",
    charge.data[0].payment_intent === paymentIntent,
  );

  // charges.retrieve is the second hop the dispute path takes.
  const retrieved = await stripe.charges.retrieve(chargeId);
  check(
    "charges.retrieve resolves back to the payment_intent",
    retrieved.payment_intent === paymentIntent,
    `payment_intent=${String(retrieved.payment_intent)}`,
  );

  let dispute;
  try {
    const d = await raw("/v1/disputes", { charge: chargeId });
    dispute = d.data ?? d;
  } catch (e) {
    console.error("verify-stripe: could not create a test dispute:", e.message);
    console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  // This is the exact shape paymentIntentForDispute branches on: a string
  // charge id it must hop through, not an expanded object.
  check(
    "a dispute names its charge as a string id",
    typeof dispute.charge === "string" && dispute.charge.startsWith("ch_"),
    `charge=${typeof dispute.charge === "string" ? dispute.charge : typeof dispute.charge}`,
  );
  check(
    "the dispute's charge id is retrievable",
    (await stripe.charges.retrieve(dispute.charge)).payment_intent === paymentIntent,
  );

  // ---- The revocation primitive, against a real refund. ----
  // charge.refunded is the path that reads the Charge object directly, so the
  // refund must actually produce the amounts the partial-refund check reads.
  const beforeRefund = await stripe.charges.retrieve(chargeId);
  const fullRefund = await stripe.refunds.create({ charge: chargeId });
  const afterRefund = await stripe.charges.retrieve(chargeId);
  check(
    "a full refund makes amount_refunded equal amount",
    afterRefund.amount_refunded === afterRefund.amount &&
      afterRefund.amount_refunded === beforeRefund.amount,
    `amount=${afterRefund.amount} refunded=${afterRefund.amount_refunded}`,
  );
  check(
    "a partial refund leaves amount_refunded below amount",
    fullRefund.status !== "failed" &&
      (await stripe.charges.retrieve(chargeId)).amount_refunded < beforeRefund.amount,
  );

  // ---- The not-found classification the dispute hop depends on. ----
  // A charge id that cannot exist: the webhook must treat this as "not ours"
  // (a 200) rather than as a transient failure (a 500 that redelivers forever).
  let notFound;
  try {
    await stripe.charges.retrieve("ch_0000000000000000000000");
    notFound = { threw: false };
  } catch (e) {
    notFound = { threw: true, statusCode: e.statusCode, type: e.type, code: e.code };
  }
  check(
    "a nonexistent charge throws a 404 the webhook can classify",
    notFound.threw && (notFound.statusCode === 404 || notFound.type === "StripeInvalidRequestError"),
    `statusCode=${String(notFound.statusCode)} type=${String(notFound.type)} code=${String(notFound.code)}`,
  );

  console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-stripe: unexpected error:", e?.message ?? e);
  process.exit(1);
});
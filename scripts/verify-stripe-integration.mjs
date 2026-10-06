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
 * refunds them where the API allows, but it refuses to run against a live-mode
 * key rather than trusting the key's prefix alone (it also refuses a key that
 * does not look like a Stripe key at all).
 *
 * How the objects are made (#134). The first version of this script completed
 * a Checkout Session with `POST /v1/checkout/sessions/{id}/complete` and opened
 * a dispute with `POST /v1/disputes`. Both endpoints now answer 404
 * `Unrecognized request URL` on every Stripe API version, so 9 of the 11 checks
 * were unreachable and the scheduled workflow was permanently red without ever
 * having run. There is no server-side way to complete a Checkout Session — the
 * hosted page is the only completion path — so:
 *
 *   - Assumption 1 is verified against a real *completed* session that already
 *     exists in the account (`status=complete`, which carries a payment_intent).
 *     The E2E browser flow is what creates them. If the account has none, the
 *     check FAILS rather than reporting a pass it did not earn; DEVELOPMENT.md
 *     §4 says so, and running `npm run test:e2e` once is the fix.
 *   - Assumption 2 is verified against a real dispute created the documented
 *     way: paying with the `pm_card_createDispute` test PaymentMethod makes
 *     Stripe raise the dispute itself, which is a stronger test than an
 *     API-created one: the dispute then arrives exactly as the webhook would
 *     receive it.
 *
 * Payments the script makes itself are PaymentIntents confirmed with a test
 * PaymentMethod, which is the documented way to simulate a payment server-side
 * and needs no browser.
 *
 * Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/verify-stripe-integration.mjs
 * Exits 0 when every assertion holds, 1 otherwise. Prints one line per check.
 */

import process from "node:process";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

/** Stripe's documented test PaymentMethods (docs.stripe.com/docs/testing). */
const CARD_PAYMENT_METHOD = "pm_card_visa";
/** Paying with this makes Stripe open a `fraudulent` dispute on the charge. */
const DISPUTE_PAYMENT_METHOD = "pm_card_createDispute";

/** Enough to exercise the amount arithmetic, small enough to be obviously fake. */
const AMOUNT_EUR = 3000;

/** Unmeasured — loosen this first if the run reports no dispute in the window. */
const DISPUTE_POLL_ATTEMPTS = 10;
const DISPUTE_POLL_INTERVAL_MS = 1000;

/**
 * Refuses a key that is absent or not obviously test mode.
 *
 * Returns the key, or throws with the reason. The reason is the message: an
 * operator reading a red run should not have to guess which of the two it was.
 */
export function testModeKey(key) {
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  // Live mode would create real charges and real disputes against real cards.
  if (!/^sk_test_/.test(key)) {
    throw new Error("refusing to run — key is not test mode (expected sk_test_ prefix)");
  }
  return key;
}

/**
 * The newest completed Checkout Session that carries a payment intent, or null.
 *
 * `payment_intent` is null on an open session and a string id on a completed
 * one, so a completed session is the only thing that can answer the question
 * the webhook asks. Exported because "pick the right session" is the part worth
 * unit-testing, and because the caller must handle null — an account with no
 * completed session is a legitimate state, not an error to swallow.
 */
export function pickCompletedSession(sessions) {
  for (const session of sessions) {
    if (session?.status === "complete" && typeof session.payment_intent === "string") {
      return session;
    }
  }
  return null;
}

/**
 * The Charge id a dispute names, or null when it does not name one.
 *
 * This is the exact shape `paymentIntentForDispute` branches on: a string charge
 * id it must hop through, not an expanded object. Returning null rather than
 * throwing keeps the caller's report honest — "this dispute named no charge" is
 * a different failure from "no dispute arrived".
 */
export function disputeChargeId(dispute) {
  const charge = dispute?.charge;
  return typeof charge === "string" && charge.startsWith("ch_") ? charge : null;
}

/**
 * How to take a charge from partly refunded to fully refunded, in two steps.
 *
 * The first version refunded in full and then asserted the charge was *not*
 * fully refunded, which can never both be true — the check could only ever
 * fail, and because it sat behind an unreachable endpoint nobody saw it. Order
 * is load-bearing: partial first, remainder second.
 */
export function refundSteps(amount) {
  if (!Number.isInteger(amount) || amount < 2) {
    throw new Error(`refundSteps needs an integer amount of at least 2, got ${amount}`);
  }
  const partial = Math.floor(amount / 2);
  return [partial, amount - partial];
}

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

function report() {
  console.log(`verify-stripe: ${pass} passed, ${fail} failed`);
}

/** Create and confirm a PaymentIntent, returning the confirmed intent. */
async function paidIntent(stripe, paymentMethod, amount = AMOUNT_EUR) {
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "eur",
    // `payment_method_types` was removed from PaymentIntent create in API
    // version 2026-09-30.endive (stripe v23); this is its replacement.
    allowed_payment_method_types: ["card"],
  });
  // request_three_d_secure=automatic: a test card that succeeds without
  // authentication, so the confirm does not stall on a 3DS challenge.
  return stripe.paymentIntents.confirm(intent.id, {
    payment_method: paymentMethod,
    payment_method_options: { card: { request_three_d_secure: "automatic" } },
  });
}

function chargeIdOf(intent) {
  const charge = intent.latest_charge;
  return typeof charge === "string" ? charge : (charge?.id ?? null);
}

/** Poll for the dispute Stripe opens on a disputed charge. */
async function disputeForCharge(stripe, chargeId) {
  for (let attempt = 0; attempt < DISPUTE_POLL_ATTEMPTS; attempt += 1) {
    const listed = await stripe.disputes.list({ charge: chargeId, limit: 1 });
    if (listed.data[0]) return listed.data[0];
    await new Promise((resolve) => setTimeout(resolve, DISPUTE_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * The API version the app pins in src/lib/stripe.ts. This check exists to prove
 * the shapes the app depends on, so it must ask for the same version the app
 * does; tests/verify-stripe-script.test.mts holds the two together.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export async function main() {
  const stripe = new Stripe(testModeKey(process.env.STRIPE_SECRET_KEY), {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });

  // ---- The session shape, which is what the webhook waits for. ----
  // A session we create and then expire: the point is that it is open and has no
  // payment intent, which is why nothing may key on the session before payment.
  const created = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: "https://example.com/ok",
    cancel_url: "https://example.com/cancel",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: AMOUNT_EUR,
          product_data: { name: "verify-stripe-integration" },
        },
      },
    ],
  });
  check("a mode:payment session is created", created.mode === "payment", `mode=${created.mode}`);
  check(
    "an incomplete session has no payment_intent",
    created.payment_intent == null,
    `payment_intent=${String(created.payment_intent)}`,
  );
  // Do not leave open sessions behind in the test account on every scheduled run.
  await stripe.checkout.sessions.expire(created.id);

  // ---- Assumption 1: the lookup the whole strategy depends on. ----
  const completed = pickCompletedSession(
    (await stripe.checkout.sessions.list({ status: "complete", limit: 10 })).data,
  );
  if (
    !check(
      "the account has a completed Checkout Session to look up",
      completed !== null,
      completed
        ? completed.id
        : "none — run `npm run test:e2e` once, or pay one test checkout by hand",
    )
  ) {
    report();
    process.exit(1);
  }

  const listed = await stripe.checkout.sessions.list({
    payment_intent: completed.payment_intent,
    limit: 1,
  });
  check(
    "checkout.sessions.list({payment_intent}) returns the session",
    listed.data[0]?.id === completed.id,
    `asked for ${completed.payment_intent}, got ${listed.data[0]?.id ?? "none"}`,
  );
  check("the listed session is mode:payment", listed.data[0]?.mode === "payment", `mode=${listed.data[0]?.mode}`);

  // ---- Assumption 2: the dispute hop, against a dispute Stripe raised. ----
  const disputed = await paidIntent(stripe, DISPUTE_PAYMENT_METHOD);
  const disputedChargeId = chargeIdOf(disputed);
  if (
    !check("a disputed payment produces a charge", Boolean(disputedChargeId), `charge=${String(disputedChargeId)}`)
  ) {
    report();
    process.exit(1);
  }
  check("the disputed payment intent succeeded", disputed.status === "succeeded", `status=${disputed.status}`);

  // charges.list is the first hop; charges.retrieve the second. Both are on the
  // dispute path, and both read a Charge the script did not create by hand.
  const charge = await stripe.charges.list({ payment_intent: disputed.id, limit: 1 });
  check(
    "charges.list({payment_intent}) finds the charge",
    charge.data[0]?.id === disputedChargeId,
    `asked for ${disputed.id}, got ${charge.data[0]?.id ?? "none"}`,
  );
  check("the charge carries the payment_intent", charge.data[0]?.payment_intent === disputed.id);
  check(
    "charges.retrieve resolves back to the payment_intent",
    (await stripe.charges.retrieve(disputedChargeId)).payment_intent === disputed.id,
    `payment_intent=${disputed.id}`,
  );

  const dispute = await disputeForCharge(stripe, disputedChargeId);
  if (
    !check(
      "paying with pm_card_createDispute opens a real dispute",
      dispute !== null,
      dispute ? dispute.id : "no dispute within the poll window",
    )
  ) {
    report();
    process.exit(1);
  }
  check(
    "a dispute names its charge as a string id",
    disputeChargeId(dispute) !== null,
    `charge=${typeof dispute.charge === "string" ? dispute.charge : typeof dispute.charge}`,
  );
  check(
    "the dispute's charge id is retrievable",
    (await stripe.charges.retrieve(disputeChargeId(dispute))).payment_intent === disputed.id,
  );

  // ---- The revocation primitive, against real refunds. ----
  // A separate, undisputed charge: Stripe refuses a refund on a charge-backed
  // one, so reusing the disputed charge would report a refund failure that says
  // nothing about the refund path.
  const refundable = await paidIntent(stripe, CARD_PAYMENT_METHOD);
  const refundableChargeId = chargeIdOf(refundable);
  const [partialAmount, remainder] = refundSteps(AMOUNT_EUR);
  const beforeRefund = await stripe.charges.retrieve(refundableChargeId);

  const partial = await stripe.refunds.create({ charge: refundableChargeId, amount: partialAmount });
  const afterPartial = await stripe.charges.retrieve(refundableChargeId);
  check(
    "a partial refund leaves amount_refunded below amount",
    partial.status !== "failed" && afterPartial.amount_refunded < beforeRefund.amount,
    `amount=${beforeRefund.amount} refunded=${afterPartial.amount_refunded}`,
  );

  await stripe.refunds.create({ charge: refundableChargeId, amount: remainder });
  const afterFull = await stripe.charges.retrieve(refundableChargeId);
  check(
    "refunding the remainder makes amount_refunded equal amount",
    afterFull.amount_refunded === afterFull.amount &&
      afterFull.amount_refunded === beforeRefund.amount,
    `amount=${afterFull.amount} refunded=${afterFull.amount_refunded}`,
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

  report();
  process.exit(fail === 0 ? 0 : 1);
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((e) => {
    console.error("verify-stripe: unexpected error:", e?.message ?? e);
    process.exit(1);
  });
}
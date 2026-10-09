import assert from "node:assert/strict";
import test from "node:test";
import { STRIPE_API_VERSION as APP_API_VERSION } from "../src/infrastructure/stripe/stripe.ts";
import {
  STRIPE_API_VERSION,
  disputeChargeId,
  pickCompletedSession,
  refundSteps,
  testModeKey,
} from "../scripts/verify-stripe-integration.mjs";

/**
 * The pure parts of the live Stripe check (#134).
 *
 * The script itself is the only thing that can prove the API shapes, and it can
 * only run against a real test-mode account. What it *decides* — which session
 * answers the lookup, whether a dispute named a charge, how much to refund and
 * in what order — is ordinary logic that can be pinned here, so a refactor that
 * inverts an order or accepts a null where the code assumes a string fails here
 * rather than in a scheduled workflow nobody is watching.
 *
 * The refund order is the one that matters. The previous script refunded in
 * full and then asserted the charge was not fully refunded; both can never hold,
 * so the check could only ever fail, and it sat behind an endpoint that had
 * already stopped existing.
 */

test("testModeKey refuses an absent key and a live-mode key", () => {
  assert.throws(() => testModeKey(undefined), /STRIPE_SECRET_KEY is not set/);
  assert.throws(() => testModeKey(""), /STRIPE_SECRET_KEY is not set/);
  assert.throws(() => testModeKey(`sk_live_${"0".repeat(24)}`), /refusing to run/);
  // A key that does not look like a Stripe key at all is refused too, rather
  // than trusted because it happened not to start with sk_live_.
  assert.throws(() => testModeKey("not-a-key"), /refusing to run/);
  assert.equal(testModeKey(`sk_test_${"0".repeat(24)}`), `sk_test_${"0".repeat(24)}`);
});

test("pickCompletedSession takes a completed session with a payment intent", () => {
  const complete = {
    id: "cs_test_a",
    status: "complete",
    mode: "payment",
    payment_intent: "pi_1",
  };
  assert.equal(pickCompletedSession([complete]), complete);

  // An open session has no payment_intent, so it cannot answer the lookup the
  // webhook makes. It must be skipped, not returned and dereferenced later.
  const open = { id: "cs_test_b", status: "open", mode: "payment", payment_intent: null };
  assert.equal(pickCompletedSession([open, complete]), complete);

  // An expanded object rather than a string id is not the shape the production
  // code branches on, so it must not be selected either.
  const expanded = { id: "cs_test_c", status: "complete", payment_intent: { id: "pi_2" } };
  assert.equal(pickCompletedSession([expanded]), null);

  assert.equal(pickCompletedSession([]), null);
  // A malformed entry must not throw: the list is Stripe's, not ours.
  assert.equal(pickCompletedSession([null, undefined, 42]), null);
});

test("disputeChargeId accepts only a string charge id", () => {
  assert.equal(disputeChargeId({ charge: "ch_1abc" }), "ch_1abc");
  // The expanded-object shape the function must refuse: paymentIntentForDispute
  // treats it as a different branch, so a dispute carrying one is not the shape
  // this check is verifying.
  assert.equal(disputeChargeId({ charge: { id: "ch_1abc" } }), null);
  assert.equal(disputeChargeId({ charge: "pi_1abc" }), null);
  assert.equal(disputeChargeId({}), null);
  assert.equal(disputeChargeId(null), null);
});

test("refundSteps refunds partially first and exactly covers the amount", () => {
  const [partial, remainder] = refundSteps(3000);
  assert.deepEqual([partial, remainder], [1500, 1500]);
  // The order is the assertion: partial must come first, or the "still partly
  // refunded" check can never observe an intermediate state.
  assert.ok(partial < 3000);
  assert.equal(partial + remainder, 3000);

  // An odd amount must still sum exactly — a lost cent would make the final
  // "amount_refunded === amount" check fail for a reason that is not Stripe's.
  const [a, b] = refundSteps(3001);
  assert.equal(a + b, 3001);
  assert.ok(a < b);

  assert.throws(() => refundSteps(1), /at least 2/);
  assert.throws(() => refundSteps(1500.5), /at least 2/);
  assert.throws(() => refundSteps("3000"), /at least 2/);
});

test("the live check asks Stripe for the API version the app pins", () => {
  // A check that proves the shapes of a different API version than checkout
  // and the webhook use proves nothing about them.
  assert.equal(STRIPE_API_VERSION, APP_API_VERSION);
});

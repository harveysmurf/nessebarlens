/**
 * Refund and dispute revocation.
 *
 * The orders store is keyed by Stripe Checkout session id and stores no payment
 * intent, so `charge.refunded` — whose object *is* a Charge, carrying
 * `payment_intent` — has nothing to look the order up by. We ask Stripe:
 * `checkout.sessions.list({ payment_intent })` returns the session that
 * payment came from, and that session id is our primary key.
 *
 * The alternative (storing `payment_intent` on the record plus a second index)
 * was rejected under KV because the index could not be enumerated and would
 * grow forever; under D1 it is still rejected — one read against an API we
 * already call from /api/checkout reaches every already-paid record, which is
 * where the money at risk actually is.
 *
 * The cost of that choice, stated plainly: revocation now depends on Stripe
 * being reachable at the moment the webhook fires. That is why a lookup
 * failure answers 5xx (Stripe redelivers) rather than 200, and why the status
 * write happens after the lookup rather than being skipped on failure.
 *
 * Writes use `transitionOrder` (#116) so a double-refund webhook cannot cancel
 * the same Prodigi order twice: the losing transition answers 200 duplicate
 * and skips cancel.
 */

import { type OrdersStore } from "../../infrastructure/cloudflare/orders-store";
import { describeCorruptOrder, reportCorruptOrder } from "../../domain/ordering/order-corrupt";
import {
  isRevoked,
  parseOrderRecord,
  type OrderRecord,
  type RevokedStatus,
} from "../../domain/ordering/order-decision";
import { cancelProdigiOrder, type CancelProdigiOrder } from "../../infrastructure/prodigi/prodigi-cancel";
import { stripeSessionLookup } from "../../infrastructure/stripe/stripe-gateway";
import { isChargeId, isPaymentIntentId, isStripeNotFound } from "../../infrastructure/stripe/stripe-ids";

/** The slice of the Stripe client this module needs. Injected by the tests. */
export type StripeSessionLookup = {
  findSessionIdByPaymentIntent: (
    paymentIntent: string,
  ) => Promise<string | null>;
  /** Dispute objects name a Charge id; the payment intent is one hop away. */
  findPaymentIntentForCharge: (chargeId: string) => Promise<string | null>;
};

// The pure id/error predicates live in `stripe-ids.ts` so the Stripe adapter can
// share them without this module and the adapter importing each other. They stay
// re-exported here because the revocation tests and the webhook route know them
// by this path.
export { isChargeId, isPaymentIntentId, isStripeNotFound };

export function defaultStripeLookup(): StripeSessionLookup {
  // The Stripe client construction moved to the adapter (`stripe-gateway.ts`)
  // so this module no longer reaches into the SDK. Kept as a named export
  // because the revocation tests and the webhook route call it by this name.
  return stripeSessionLookup();
}

export type RevocationOutcome =
  /** Nothing to do, or done. 200 either way — never make Stripe redeliver. */
  | { httpStatus: 200; body: Record<string, unknown> }
  /** Transient dependency failure. 5xx so Stripe redelivers. */
  | { httpStatus: 500; body: Record<string, unknown> };

export type RevokeInput = {
  store: OrdersStore;
  status: RevokedStatus;
  paymentIntent: string | null | undefined;
  now: string;
  stripe?: StripeSessionLookup;
  cancel?: CancelProdigiOrder;
};

/**
 * Write the revoked status onto the stored order, or explain why there is
 * nothing to write. `unknown-order` is a 200 and not an error: the payment may
 * simply not be ours (another Stripe account's charge reaching the wrong
 * endpoint), and redelivering that forever helps nobody.
 */
export async function revokeOrderByPaymentIntent(
  input: RevokeInput,
): Promise<RevocationOutcome> {
  const paymentIntent = input.paymentIntent;
  if (!isPaymentIntentId(paymentIntent)) {
    return {
      httpStatus: 200,
      body: { received: true, ignored: "no-payment-intent" },
    };
  }

  const lookup = input.stripe ?? defaultStripeLookup();

  let sessionId: string | null;
  try {
    sessionId = await lookup.findSessionIdByPaymentIntent(paymentIntent);
  } catch (e) {
    // The one failure mode option (A) would not have had. Log it and answer
    // 5xx: the refund is real, we simply could not look it up, and dropping it
    // would leave a refunded buyer holding the master file forever.
    console.error(
      JSON.stringify({
        event: "order.revocation-lookup-failed",
        paymentIntent,
        status: input.status,
        detail: e instanceof Error ? e.message : "unknown",
      }),
    );
    return {
      httpStatus: 500,
      body: { error: "revocation-lookup-failed" },
    };
  }

  if (!sessionId) {
    return {
      httpStatus: 200,
      body: { received: true, ignored: "unknown-payment-intent" },
    };
  }

  const raw = await input.store.getOrder(sessionId);
  if (raw === null) {
    return {
      httpStatus: 200,
      body: { received: true, ignored: "unknown-order", sessionId },
    };
  }

  const order = parseOrderRecord(raw);
  if (!order) {
    // A record we cannot parse is also one we must not overwrite: writing a
    // status over it would replace whatever a human is looking at. Answer 200
    // and complain loudly; this is not a redelivery Stripe can fix.
    reportCorruptOrder(
      sessionId,
      "revoke",
      describeCorruptOrder(raw, sessionId),
    );
    return {
      httpStatus: 200,
      body: { received: true, ignored: "corrupt-order", sessionId },
    };
  }

  if (isRevoked(order.status)) {
    return {
      httpStatus: 200,
      body: {
        received: true,
        duplicate: true,
        status: order.status,
        sessionId,
      },
    };
  }

  const revoked: OrderRecord = {
    ...order,
    status: input.status,
    terminal: true,
    reason: null,
    // The record keeps photoSlug/size/frame so the refund is auditable, but it
    // no longer names the master. parseOrderRecord enforces masterKey === null
    // for a revoked order, so this is load-bearing, not cosmetic.
    masterKey: null,
    updatedAt: input.now,
  };

  // Write first, cancel second. Revocation is the part that protects the
  // customer; a Prodigi failure must not be able to delay or undo it. The
  // transition is the claim: a concurrent second refund that loses the
  // optimistic lock answers duplicate below and must not cancel Prodigi twice.
  const claimed = await input.store.transitionOrder({
    sessionId,
    fromAttempts: order.attempts,
    record: revoked,
  });
  if (!claimed) {
    return {
      httpStatus: 200,
      body: {
        received: true,
        duplicate: true,
        sessionId,
      },
    };
  }

  const cancellation =
    order.kind === "physical" && order.prodigiOrderId
      ? await (input.cancel ?? cancelProdigiOrder)({
          prodigiOrderId: order.prodigiOrderId,
          sessionId,
        })
      : null;

  if (cancellation && !cancellation.ok) {
    // Log for a human, never a webhook failure. Prodigi's cancel semantics are
    // not something we could verify from here (docs.prodigi.com does not
    // resolve from this environment and there is no sandbox key), so the
    // operator gets the stage and the HTTP status and decides.
    console.error(
      JSON.stringify({
        event: "order.prodigi-cancel-failed",
        sessionId,
        prodigiOrderId: order.prodigiOrderId,
        prodigiStage: order.prodigiStage,
        status: input.status,
        reason: cancellation.reason,
        detail: cancellation.message,
      }),
    );
  }

  return {
    httpStatus: 200,
    body: {
      received: true,
      revoked: true,
      status: revoked.status,
      format: revoked.format,
      prodigiCancelled: cancellation ? cancellation.ok : null,
    },
  };
}

/**
 * A dispute's object names a Charge, not a PaymentIntent, so the payment
 * intent is one retrieve away. Resolved here rather than in the route so the
 * two-hop shape is testable without a Stripe client.
 */
export async function paymentIntentForDispute(
  dispute: { charge?: string | { payment_intent?: string | null } | null },
  lookup: StripeSessionLookup,
): Promise<string | null> {
  const charge = dispute.charge;
  if (!charge) return null;
  if (typeof charge !== "string") {
    return isPaymentIntentId(charge.payment_intent)
      ? charge.payment_intent
      : null;
  }
  if (!isChargeId(charge)) return null;
  // Deliberately no catch here. A charge that resolves to no payment intent is
  // a different thing from a lookup that failed: the first means the charge is
  // not ours (200, ignore), the second means Stripe was unreachable and the
  // dispute is real, so it must propagate to the route and be answered 5xx so
  // Stripe redelivers. Swallowing it as `null` would answer 200
  // "no-payment-intent" and leave a disputed buyer holding the master file.
  return lookup.findPaymentIntentForCharge(charge);
}

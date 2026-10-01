/**
 * Refund and dispute revocation.
 *
 * ORDERS is keyed by Stripe Checkout session id and stores no payment intent,
 * so `charge.refunded` — whose object *is* a Charge, carrying
 * `payment_intent` — has nothing to look the order up by. We ask Stripe:
 * `checkout.sessions.list({ payment_intent })` returns the session that
 * payment came from, and that session id is our primary key.
 *
 * The alternative (storing `payment_intent` on the record plus a second
 * `pi_…` KV index key) was rejected: KV cannot enumerate that index, so it
 * would grow forever and never be provably complete, and it would only ever
 * cover orders placed *after* the deploy — every already-paid record, which is
 * where the money at risk actually is, would stay unrefundable by webhook.
 * One read against an API we already call from /api/checkout reaches all of
 * them.
 *
 * The cost of that choice, stated plainly: revocation now depends on Stripe
 * being reachable at the moment the webhook fires. That is why a lookup
 * failure answers 5xx (Stripe redelivers) rather than 200, and why the status
 * write happens after the lookup rather than being skipped on failure.
 */

import { type OrdersKv } from "./fulfillment";
import {
  isRevoked,
  parseOrderRecord,
  type OrderRecord,
  type RevokedStatus,
} from "./order-decision";
import { cancelProdigiOrder, type CancelProdigiOrder } from "./prodigi-cancel";
import { getStripe } from "./stripe";

/** The slice of the Stripe client this module needs. Injected by the tests. */
export type StripeSessionLookup = {
  findSessionIdByPaymentIntent: (
    paymentIntent: string,
  ) => Promise<string | null>;
  /** Dispute objects name a Charge id; the payment intent is one hop away. */
  findPaymentIntentForCharge: (chargeId: string) => Promise<string | null>;
};

const PAYMENT_INTENT_PATTERN = /^pi_[A-Za-z0-9_]{8,128}$/;

export function isPaymentIntentId(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_INTENT_PATTERN.test(value);
}

const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9_]{8,128}$/;

export function isChargeId(value: unknown): value is string {
  return typeof value === "string" && CHARGE_ID_PATTERN.test(value);
}

/**
 * Is this Stripe error the "that resource does not exist" answer?
 *
 * Structural on purpose rather than `instanceof Stripe.StripeInvalidRequestError`:
 * the stripe package is a runtime dependency of this module already, but the
 * webhook's error classification is a property worth being able to test without
 * constructing Stripe errors, and Stripe errors carry the status on the object.
 * A 404 status and the invalid-request type are both definitive not-found; a
 * 5xx, a rate limit and a connection error are all transient and must rethrow.
 */
export function isStripeNotFound(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { statusCode, type, code } = e as {
    statusCode?: unknown;
    type?: unknown;
    code?: unknown;
  };
  if (statusCode === 404) return true;
  if (type === "StripeInvalidRequestError" && statusCode === undefined)
    return true;
  return code === "resource_missing";
}

export function defaultStripeLookup(): StripeSessionLookup {
  return {
    findSessionIdByPaymentIntent: async (paymentIntent) => {
      const stripe = getStripe();
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntent,
        limit: 1,
      });
      return sessions.data[0]?.id ?? null;
    },
    findPaymentIntentForCharge: async (chargeId) => {
      const stripe = getStripe();
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        return isPaymentIntentId(charge.payment_intent)
          ? charge.payment_intent
          : null;
      } catch (e) {
        // "No such charge" is a legitimate answer — the charge is not ours, or
        // is gone. A 5xx/timeout/network failure is not: that is our outage,
        // and treating it as "not ours" drops a real dispute on the floor.
        // Only the definitive not-found classes are swallowed.
        if (isStripeNotFound(e)) {
          console.error(
            JSON.stringify({
              event: "order.dispute-charge-not-found",
              charge: chargeId,
              detail: e instanceof Error ? e.message : "unknown",
            }),
          );
          return null;
        }
        throw e;
      }
    },
  };
}

export type RevocationOutcome =
  /** Nothing to do, or done. 200 either way — never make Stripe redeliver. */
  | { httpStatus: 200; body: Record<string, unknown> }
  /** Transient dependency failure. 5xx so Stripe redelivers. */
  | { httpStatus: 500; body: Record<string, unknown> };

export type RevokeInput = {
  kv: OrdersKv;
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

  const raw = await input.kv.get(sessionId);
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
    console.error(
      JSON.stringify({ event: "order.corrupt", sessionId, path: "revoke" }),
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
  // customer; a Prodigi failure must not be able to delay or undo it.
  await input.kv.put(sessionId, JSON.stringify(revoked));

  const cancellation =
    order.format !== "digital" &&
    order.format !== "unknown" &&
    order.prodigiOrderId
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

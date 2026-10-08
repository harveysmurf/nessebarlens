/**
 * Pure Stripe identifier and error-shape predicates (#3, DDD).
 *
 * These are the small structural checks that decide whether a string is a
 * Stripe id and whether a thrown error is the "does not exist" answer. They
 * carry no SDK import and no I/O, so both the domain-ish revocation module and
 * the Stripe adapter can share them without either importing the other. That is
 * what keeps `stripe-gateway.ts` from reaching into `order-revocation.ts` at
 * runtime and closing an import cycle.
 */

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
 * the webhook's error classification is a property worth being able to test
 * without constructing Stripe errors, and Stripe errors carry the status on the
 * object. A 404 status and the invalid-request type are both definitive
 * not-found; a 5xx, a rate limit and a connection error are all transient and
 * must rethrow.
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

/**
 * The Stripe session-lookup port, owned by the domain (#3, DDD).
 *
 * The application depends on this interface; infrastructure/stripe/stripe-gateway.ts
 * implements it with the Stripe SDK and the `stripe-ids.ts` predicates hidden
 * behind the vendor-neutral methods. Moving `StripeSessionLookup` here lets
 * `order-revocation.ts` import the type from domain rather than from
 * infrastructure or from `application/fulfillment/order-revocation.ts` itself
 * (which would re-create the import cycle the port extraction removes).
 */

/**
 * The lookup the refund/dispute path needs from a payment provider.
 *
 * The `isPaymentReference` / `isChargeReference` / `isNotFound` methods are
 * the structural predicates that were `isPaymentIntentId` / `isChargeId` /
 * `isStripeNotFound` in `infrastructure/stripe/stripe-ids.ts` — vendor-neutral
 * names so the domain never mentions Stripe. The Stripe adapter wires the two
 * shapes together.
 */
export type StripeSessionLookup = {
  findSessionIdByPaymentIntent: (
    paymentIntent: string,
  ) => Promise<string | null>;
  /** Dispute objects name a Charge id; the payment intent is one hop away. */
  findPaymentIntentForCharge: (chargeId: string) => Promise<string | null>;
  /** True when `value` is a payment-intent reference (e.g. "pi_…"). */
  isPaymentReference: (value: string) => boolean;
  /** True when `value` is a charge reference (e.g. "ch_…"). */
  isChargeReference: (value: string) => boolean;
  /** True when a thrown error means the referenced resource does not exist. */
  isNotFound: (error: unknown) => boolean;
};

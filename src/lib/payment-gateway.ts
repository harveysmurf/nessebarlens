/**
 * The payment gateway port (#3, DDD).
 *
 * The rest of the checkout/fulfillment application talks to this interface,
 * never to a payment SDK. Everything here is domain vocabulary: an intent to
 * charge, a created session, and the event shapes a payment provider delivers.
 * `stripe-gateway.ts` is the one adapter that knows the Stripe SDK, and it maps
 * its types onto these at the boundary. No `Stripe.*` type may cross into or
 * out of this module.
 *
 * Deliberately absent: `enum`/`namespace`/parameter properties (repo rule).
 */

import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";
import type { ShipToCountryCode } from "./ship-to-countries";
import type { StripeShippingDetails } from "./order-decision";

/**
 * What the customer is buying, in domain terms. The adapter is responsible for
 * translating it into a provider request — the fields here are the same ones
 * the checkout route already had, so the mapping is behaviour-preserving.
 */
export type CheckoutIntent = {
  /** Product name shown on the hosted checkout page. */
  title: string;
  format: PrintFormat;
  /** Physical orders only; null for digital. */
  size: PrintSize | null;
  frame: FrameFinish | null;
  /** The public web derivative the provider shows, or null when unconfigured. */
  previewImage: string | null;
  quoteEur: number;
  /** Zero for digital; the quoted Prodigi shipping otherwise. */
  shippingEur: number;
  /** Lock the provider's address collection to the quoted destination. */
  destinationCountryCode: ShipToCountryCode | null;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
};

/** The success payload of `createCheckout`. */
export type CreatedCheckoutSession = {
  url: string;
  sessionId: string;
};

/**
 * The reasons a checkout could not be created. `unconfigured` is a deploy-time
 * fact answered 503; the other two are upstream failures answered 502.
 */
export type CreateCheckoutResult =
  | { ok: true; value: CreatedCheckoutSession }
  | { ok: false; reason: "unconfigured" | "unavailable" | "no-url" };

/**
 * The fields the fulfillment path reads off a Checkout Session, minus the SDK's
 * own shape. The two shipping slots mirror Stripe's two locations for an
 * address (`collected_information.shipping_details` and `shipping_details`);
 * the fulfillment mapping prefers the collected one.
 */
export type PaymentCheckoutSession = {
  id: string | null;
  paymentStatus: string | null;
  currency: string | null;
  amountTotal: number | null;
  metadata: Record<string, string> | null;
  shippingDetails: StripeShippingDetails | null;
  collectedShippingDetails: StripeShippingDetails | null;
  customerEmail: string | null;
  customerPhone: string | null;
  successUrl: string | null;
};

/** A dispute names a Charge; the object is only ever a string for us. */
export type PaymentDispute = {
  charge: string | null;
};

/**
 * A payment event, narrowed to the four things this application acts on. Every
 * event the application ignores collapses to `other`, which keeps the adapter's
 * translation table small and the handler's branches explicit.
 */
export type PaymentEvent =
  | { kind: "checkout-session"; type: string; session: PaymentCheckoutSession }
  | {
      kind: "charge-refunded";
      type: "charge.refunded";
      paymentIntent: string | null;
      amount: number | null;
      amountRefunded: number | null;
    }
  | {
      kind: "dispute-created";
      type: "charge.dispute.created";
      dispute: PaymentDispute;
    }
  | { kind: "other"; type: string };

export type VerifyWebhookResult =
  | { ok: true; event: PaymentEvent }
  | { ok: false; reason: "invalid-signature" };

/**
 * The port. Two operations: create a hosted checkout, and turn a raw signed
 * webhook into a domain event. The webhook secret is passed in rather than
 * read here, so the adapter stays free of configuration.
 */
export type PaymentGateway = {
  createCheckout(intent: CheckoutIntent): Promise<CreateCheckoutResult>;
  verifyAndParseWebhook(input: {
    rawBody: string;
    signature: string;
    secret: string;
  }): Promise<VerifyWebhookResult>;
};

/**
 * The fulfillment fields a Checkout Session contributes, in one place so the
 * webhook route and the end-to-end test derive them identically. The caller
 * adds the deployment-specific fields (`now`, config, email sender).
 */
export function fulfillmentInputFromSession(session: PaymentCheckoutSession): {
  sessionId: string;
  paymentStatus: string | null;
  currency: string | null;
  amountTotal: number | null;
  metadata: Record<string, string> | null;
  shippingDetails: StripeShippingDetails | null;
  customerEmail: string | null;
  customerPhone: string | null;
} {
  return {
    sessionId: session.id ?? "",
    paymentStatus: session.paymentStatus,
    currency: session.currency,
    amountTotal: session.amountTotal,
    metadata: session.metadata,
    shippingDetails:
      session.collectedShippingDetails ?? session.shippingDetails ?? null,
    customerEmail: session.customerEmail,
    customerPhone: session.customerPhone,
  };
}

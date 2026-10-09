/**
 * The Stripe adapter (#3, DDD).
 *
 * This is the only application module that constructs a Stripe client or names
 * a `Stripe.*` type on the way in or out. It implements the `PaymentGateway`
 * port, and it also owns the two smaller Stripe reads the app needs — the
 * payment-intent lookup for refunds/disputes and the reconciler's session read
 * — so the routes stop reaching into the SDK themselves.
 *
 * Everything it returns is domain data (`payment-gateway.ts`, `order-revocation`
 * ports, `reconcile` ports); the SDK never leaks past the functions declared
 * here.
 */

import Stripe from "stripe";
import { getStripe } from "./stripe";
import { readStripeEvent } from "./stripe-event";
import { eurToCents, formatLabel } from "../../domain/pricing/pricing";
import type { StripeShippingDetails } from "../../domain/ordering/order-decision";
import type { ReconcileSession, ReconcileStripe } from "../../application/fulfillment/reconcile";
import type { StripeSessionLookup } from "../../domain/ordering/stripe-session-lookup";
import { isPaymentIntentId, isChargeId, isStripeNotFound } from "./stripe-ids";
import type {
  CheckoutIntent,
  CreateCheckoutResult,
  PaymentCheckoutSession,
  PaymentEvent,
  PaymentGateway,
  VerifyWebhookResult,
} from "../../application/checkout/payment-gateway";

/**
 * The hosted-checkout request, built from a domain intent. Kept as its own
 * function so the route's old inline `Parameters<typeof stripe.checkout...>`
 * object lives in the adapter, typed by the SDK it belongs to.
 */
function buildSessionParams(
  intent: CheckoutIntent,
): Stripe.Checkout.SessionCreateParams {
  const isPhysical = intent.format !== "digital";
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    // Adaptive Pricing off, stated here rather than left to the dashboard
    // toggle. With it on, Stripe shows the buyer a converted local amount while
    // `amount_total` stays in the integration currency (eur) — the behaviour the
    // webhook's amount-mismatch check relies on. Pinned to the API version in
    // stripe.ts, asserted by tests/adaptive-pricing.test.mts.
    adaptive_pricing: { enabled: false },
    success_url: intent.successUrl,
    cancel_url: intent.cancelUrl,
    // Built inline rather than from a Stripe price_… ID: every price is
    // per-photo and per-quote, so there is no fixed catalogue to map onto a
    // dashboard Price.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: eurToCents(intent.quoteEur),
          product_data: {
            name: `${intent.title} — ${formatLabel(intent.format)}`,
            description: isPhysical
              ? `${intent.size}${intent.frame ? ` · ${intent.frame} frame` : ""}`
              : "Digital high-resolution license",
            images: intent.previewImage ? [intent.previewImage] : undefined,
          },
        },
      },
    ],
    metadata: intent.metadata,
  };

  if (isPhysical && intent.destinationCountryCode) {
    // Lock Stripe address to the quoted destination so the fixed shipping
    // amount matches Prodigi's rate for that country.
    params.shipping_address_collection = {
      allowed_countries: [intent.destinationCountryCode],
    };
    params.shipping_options = [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: eurToCents(intent.shippingEur),
            currency: "eur",
          },
          display_name: "Shipping",
        },
      },
    ];
  }

  return params;
}

async function createCheckout(
  intent: CheckoutIntent,
): Promise<CreateCheckoutResult> {
  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch {
    return { ok: false, reason: "unconfigured" };
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(buildSessionParams(intent));
  } catch (e) {
    // The log, not the body, is where this stays diagnosable: the SDK's error
    // carries its own `code` and the message for a connection failure. Logged
    // whole rather than through a code-or-"unknown" ternary.
    console.error("stripe.checkout.sessions.create", e);
    return { ok: false, reason: "unavailable" };
  }

  if (!session.url) return { ok: false, reason: "no-url" };
  return { ok: true, value: { url: session.url, sessionId: session.id } };
}

/**
 * Stripe moved the shipping address between `shipping_details` and
 * `collected_information.shipping_details` across API versions, and the current
 * SDK types only name the latter. The handler has always read both (see
 * `StripeCheckoutSession` in stripe-event.ts), so this reads the same two slots
 * structurally.
 */
type SessionShipping = {
  shipping_details?: StripeShippingDetails | null;
  collected_information?: {
    shipping_details?: StripeShippingDetails | null;
  } | null;
};

function toShippingDetails(
  value: StripeShippingDetails | null | undefined,
): StripeShippingDetails | null {
  return value ?? null;
}

function toPaymentSession(
  session: Stripe.Checkout.Session,
): PaymentCheckoutSession {
  const shipping = session as unknown as SessionShipping;
  return {
    id: session.id ?? null,
    paymentStatus: session.payment_status ?? null,
    currency: session.currency ?? null,
    amountTotal: session.amount_total ?? null,
    metadata: session.metadata ?? null,
    shippingDetails: toShippingDetails(shipping.shipping_details),
    collectedShippingDetails: toShippingDetails(
      shipping.collected_information?.shipping_details,
    ),
    customerEmail: session.customer_details?.email ?? null,
    customerPhone: session.customer_details?.phone ?? null,
    successUrl: session.success_url ?? null,
  };
}

/** Stripe's Charge/Dispute fields we read, typed structurally. */
type ChargeRead = {
  payment_intent?: unknown;
  amount?: unknown;
  amount_refunded?: unknown;
};

type DisputeRead = {
  charge?: unknown;
};

/**
 * Translate a verified SDK event into the domain union. Anything not in the
 * four handled shapes becomes `other`, which the route acknowledges.
 */
function toPaymentEvent(event: Stripe.Event): PaymentEvent {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    return {
      kind: "checkout-session",
      type: event.type,
      session: toPaymentSession(event.data.object as Stripe.Checkout.Session),
    };
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object as ChargeRead;
    return {
      kind: "charge-refunded",
      type: "charge.refunded",
      paymentIntent:
        typeof charge.payment_intent === "string" ? charge.payment_intent : null,
      amount: typeof charge.amount === "number" ? charge.amount : null,
      amountRefunded:
        typeof charge.amount_refunded === "number"
          ? charge.amount_refunded
          : null,
    };
  }

  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as DisputeRead;
    return {
      kind: "dispute-created",
      type: "charge.dispute.created",
      // Only a string charge is usable; an expanded Charge object is treated as
      // absent, so behaviour is unchanged.
      dispute: { charge: typeof dispute.charge === "string" ? dispute.charge : null },
    };
  }

  return { kind: "other", type: event.type };
}

async function verifyAndParseWebhook(input: {
  rawBody: string;
  signature: string;
  secret: string;
}): Promise<VerifyWebhookResult> {
  let event: Stripe.Event;
  try {
    event = await readStripeEvent(input.rawBody, input.signature, input.secret);
  } catch {
    return { ok: false, reason: "invalid-signature" };
  }
  return { ok: true, event: toPaymentEvent(event) };
}

/** The port implementation for the Stripe provider. */
export function stripeGateway(): PaymentGateway {
  return { createCheckout, verifyAndParseWebhook };
}

/**
 * The refund/dispute lookup. Owns the Stripe client construction so
 * `order-revocation.ts` (application) depends only on the
 * `StripeSessionLookup` port from domain, never on the SDK.
 */
export function stripeSessionLookup(): StripeSessionLookup {
  return {
    isPaymentReference: isPaymentIntentId,
    isChargeReference: isChargeId,
    isNotFound: isStripeNotFound,
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
        // "No such charge" is a legitimate answer; a 5xx/timeout is our outage
        // and must propagate so a real dispute is not dropped.
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

function toReconcileSession(session: {
  id: string;
  payment_status?: string | null;
  currency?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string> | null;
  shipping_details?: ReconcileSession["shipping_details"];
  collected_information?: ReconcileSession["collected_information"];
  customer_details?: ReconcileSession["customer_details"];
  success_url?: string | null;
}): ReconcileSession {
  return {
    id: session.id,
    payment_status: session.payment_status ?? null,
    currency: session.currency ?? null,
    amount_total: session.amount_total ?? null,
    metadata: session.metadata ?? null,
    shipping_details: session.shipping_details ?? null,
    collected_information: session.collected_information ?? null,
    customer_details: session.customer_details ?? null,
    success_url: session.success_url ?? null,
  };
}

/**
 * The reconciler's Stripe read, moved here from the reconcile route so
 * `src/app` no longer constructs `checkout.sessions`.
 */
export function stripeReconcileStripe(): ReconcileStripe {
  return {
    async retrieveCheckoutSession(sessionId) {
      const stripe = getStripe();
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        return toReconcileSession(session);
      } catch {
        return null;
      }
    },
    async listPaidCheckoutSessions({ createdGte, limit }) {
      const stripe = getStripe();
      const listed = await stripe.checkout.sessions.list({
        created: { gte: createdGte },
        limit,
      });
      return listed.data
        .filter((s) => s.payment_status === "paid")
        .map(toReconcileSession);
    },
  };
}

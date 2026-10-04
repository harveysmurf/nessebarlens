import { NextResponse } from "next/server";
import { fulfillCheckoutSession } from "@/lib/fulfillment";
import { getConfig } from "@/lib/config";
import { sendEmailFromApiKey } from "@/lib/email";
import {
  defaultStripeLookup,
  paymentIntentForDispute,
  revokeOrderByPaymentIntent,
} from "@/lib/order-revocation";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/lib/orders-store";
import {
  readStripeEvent,
  type StripeCheckoutSession,
} from "@/lib/stripe-event";
import { readWorkerBindings } from "@/lib/worker-bindings";
import { postcodeFromCustomFields } from "@/lib/postcode";
import type { OrdersStore } from "@/lib/orders-store";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat. Not a separate Node server.
export const runtime = "nodejs";

const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** The two money-events that take an order away from a customer. */
const REVOCATION_EVENTS = new Set(["charge.refunded", "charge.dispute.created"]);

/** The subset of a Charge this handler reads. */
type StripeCharge = {
  payment_intent?: string | null;
  amount?: number | null;
  amount_refunded?: number | null;
};

/**
 * A partial refund does not revoke anything.
 *
 * A customer who got 40% back still holds the balance that paid for the file,
 * and revoking on a partial takes a paid download away from someone who is not
 * out of pocket. The amounts are logged so the decision is visible rather than
 * silent — the alternative failure mode is an operator assuming partials were
 * considered and finding they were not.
 */
function partialRefundAmounts(
  charge: StripeCharge,
): { amount: number; amountRefunded: number } | null {
  const amount = charge.amount;
  const refunded = charge.amount_refunded;
  // Amounts missing entirely is treated as "not partial": an event we cannot
  // read the numbers off is not evidence of a partial refund, and guessing
  // either way revokes or spares a purchase on a coin toss.
  if (typeof amount !== "number" || typeof refunded !== "number") return null;
  return refunded > 0 && refunded < amount ? { amount, amountRefunded: refunded } : null;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing-signature" }, { status: 400 });
  }

  const bindings = await readWorkerBindings();
  const config = getConfig();
  // 503, not 500, and never a generic 502: "we are not configured" is a
  // deploy-time fact a human has to fix, and it must be distinguishable in the
  // logs from "Stripe is momentarily unhappy". 5xx either way, so Stripe keeps
  // redelivering and no paid session is lost while the secret is missing.
  if (!bindings.webhookSecret) {
    console.error(
      "stripe webhook unconfigured: STRIPE_WEBHOOK_SECRET is missing or empty",
    );
    return NextResponse.json(
      { error: "stripe-webhook-unconfigured" },
      { status: 503 },
    );
  }

  let event;
  try {
    event = await readStripeEvent(rawBody, signature, bindings.webhookSecret);
  } catch {
    return NextResponse.json({ error: "invalid-signature" }, { status: 400 });
  }

  const isCheckout = CHECKOUT_EVENTS.has(event.type);
  const isRevocation = REVOCATION_EVENTS.has(event.type);
  if (!isCheckout && !isRevocation) {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  if (!bindings.ORDERS_DB) {
    console.error("stripe webhook unconfigured: ORDERS_DB binding missing");
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS },
    );
  }

  try {
    // Resolution happens inside this try on purpose. A dispute needs two hops
    // and either can fail transiently; a throw from either must answer 5xx so
    // Stripe redelivers, exactly like the refund path's single hop.
    if (isRevocation) {
      // await, not a bare return: a promise returned from inside a try block
      // settles after the block has already exited, so without this the catch
      // below never sees a rejected lookup and the error escapes as an
      // unhandled rejection instead of becoming a 500.
      return await handleRevocation(event.type, event.data.object, bindings.ORDERS_DB);
    }
  } catch (e) {
    // Lookup threw. Same reasoning as the store catch below: a revoked buyer must
    // not keep the master file because Stripe was briefly unreachable, so this
    // is a redelivery, not a drop.
    console.error("stripe webhook revocation lookup failed", e);
    return NextResponse.json({ error: "revocation-lookup-failed" }, { status: 500 });
  }

  const session = event.data.object as StripeCheckoutSession;

  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null;

  try {
    const result = await fulfillCheckoutSession({
      store: bindings.ORDERS_DB,
      sessionId: session.id ?? "",
      paymentStatus: session.payment_status ?? null,
      currency: session.currency ?? null,
      amountTotal: session.amount_total ?? null,
      metadata: session.metadata ?? null,
      shippingDetails,
      // #195: the required-postcode custom field, for a Stripe address whose
      // own postal_code is blank.
      customPostcode: postcodeFromCustomFields(session.custom_fields),
      customerEmail: session.customer_details?.email ?? null,
      customerPhone: session.customer_details?.phone ?? null,
      prodigiKeyConfigured: bindings.prodigiKeyConfigured,
      now: new Date().toISOString(),
      // Read here rather than inside fulfillment, which takes its
      // configuration as an argument (config.ts is the only env reader).
      downloadLimits: {
        ttlSeconds: config.download.tokenTtlSeconds,
        maxDownloads: config.download.maxDownloads,
      },
      // Unset RESEND_API_KEY → skip with a structured log, never a throw.
      sendEmail: sendEmailFromApiKey(bindings.resendApiKey),
    });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (e) {
    // The bare catch must not answer "orders-store-unavailable" for *any* throw.
    // That is the one thing this handler must not do: a bug in fulfillment, a
    // bad PRODIGI_API_BASE, or a store write failure all presented as a missing
    // binding, so the log pointed at the wrong subsystem entirely. Log the real
    // error and keep 5xx so Stripe redelivers rather than dropping paid money.
    console.error("stripe webhook fulfillment failed", e);
    return NextResponse.json(
      { error: "fulfillment-failed" },
      { status: 500 },
    );
  }
}

async function handleRevocation(
  type: string,
  object: unknown,
  store: OrdersStore,
) {
  // Both branches resolve to a payment intent; the dispute needs one extra hop
  // because its object names a Charge, not a PaymentIntent.
  let paymentIntent: string | null | undefined;
  if (type === "charge.refunded") {
    const charge = object as StripeCharge;
    const partial = partialRefundAmounts(charge);
    if (partial) {
      console.error(
        JSON.stringify({
          event: "order.partial-refund",
          paymentIntent: charge.payment_intent ?? null,
          amount: partial.amount,
          amountRefunded: partial.amountRefunded,
        }),
      );
      return NextResponse.json({ received: true, ignored: "partial-refund" });
    }
    paymentIntent = charge.payment_intent;
  } else {
    paymentIntent = await paymentIntentForDispute(
      object as { charge?: string | null },
      defaultStripeLookup(),
    );
  }

  try {
    const result = await revokeOrderByPaymentIntent({
      store,
      status: type === "charge.refunded" ? "refunded" : "disputed",
      paymentIntent,
      now: new Date().toISOString(),
    });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (e) {
    // Store get/transition threw. Same reasoning as the fulfillment catch: a
    // revoked buyer must not keep the master file because our storage was
    // briefly unavailable, so this is a redelivery, not a drop.
    console.error("stripe webhook revocation failed", e);
    return NextResponse.json({ error: "revocation-failed" }, { status: 500 });
  }
}

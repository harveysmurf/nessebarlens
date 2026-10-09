import { NextResponse } from "next/server";
import { fulfillCheckoutSession } from "@/application/fulfillment/fulfillment";
import { getConfig, siteUrl } from "@/infrastructure/config/config";
import { sendEmailFromApiKey } from "@/domain/ordering/email";
import {
  paymentIntentForDispute,
  revokeOrderByPaymentIntent,
} from "@/application/fulfillment/order-revocation";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/domain/ordering/orders-store";
import { classifyUrlOrigin } from "@/domain/ordering/session-origin";
import {
  assetUrlSigner,
  paymentGateway,
  printProvider,
  prodigiCancel,
  stripeSessionLookupPort,
} from "@/infrastructure/container";
import {
  fulfillmentInputFromSession,
  type PaymentEvent,
} from "@/application/checkout/payment-gateway";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";
import type { OrdersStore } from "@/domain/ordering/orders-store";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat. Not a separate Node server.
export const runtime = "nodejs";

/** Either of the two money-events that take an order away from a customer. */
type RevocationEvent = Extract<
  PaymentEvent,
  { kind: "charge-refunded" | "dispute-created" }
>;

/**
 * A partial refund does not revoke anything.
 *
 * A customer who got 40% back still holds the balance that paid for the file,
 * and revoking on a partial takes a paid download away from someone who is not
 * out of pocket. The amounts are logged so the decision is visible rather than
 * silent — the alternative failure mode is an operator assuming partials were
 * considered and finding they were not.
 */
function partialRefundAmounts(charge: {
  amount: number | null;
  amountRefunded: number | null;
}): { amount: number; amountRefunded: number } | null {
  const amount = charge.amount;
  const refunded = charge.amountRefunded;
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

  const verified = await paymentGateway().verifyAndParseWebhook({
    rawBody,
    signature,
    secret: bindings.webhookSecret,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: "invalid-signature" }, { status: 400 });
  }
  const event = verified.event;

  if (event.kind === "other") {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  if (!bindings.ORDERS_DB) {
    console.error("stripe webhook unconfigured: ORDERS_DB binding missing");
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS },
    );
  }

  if (event.kind === "charge-refunded" || event.kind === "dispute-created") {
    try {
      // Resolution happens inside this try on purpose. A dispute needs two hops
      // and either can fail transiently; a throw from either must answer 5xx so
      // Stripe redelivers, exactly like the refund path's single hop.
      //
      // await, not a bare return: a promise returned from inside a try block
      // settles after the block has already exited, so without this the catch
      // below never sees a rejected lookup and the error escapes as an
      // unhandled rejection instead of becoming a 500.
      return await handleRevocation(event, bindings.ORDERS_DB);
    } catch (e) {
      // Lookup threw. Same reasoning as the store catch below: a revoked buyer
      // must not keep the master file because Stripe was briefly unreachable,
      // so this is a redelivery, not a drop.
      console.error("stripe webhook revocation lookup failed", e);
      return NextResponse.json({ error: "revocation-lookup-failed" }, { status: 500 });
    }
  }

  const session = event.session;

  // Stripe test mode delivers every session to every endpoint, so this handler
  // also sees purchases made by another environment (#193). Answering 200
  // without writing an order is the whole point: the other deployment owns that
  // payment, and writing it here is what let two builds fight over one Prodigi
  // order. 200, not 4xx — the event is delivered correctly, just not ours.
  const origin = classifyUrlOrigin(session.successUrl, siteUrl());
  if (origin === "foreign") {
    console.warn(
      JSON.stringify({
        event: "stripe.webhook.foreign-session",
        sessionId: session.id,
        sessionOrigin: session.successUrl,
        siteOrigin: siteUrl(),
      }),
    );
    return NextResponse.json({
      received: true,
      ignored: "foreign-session",
    });
  }

  try {
    const result = await fulfillCheckoutSession({
      store: bindings.ORDERS_DB,
      ...fulfillmentInputFromSession(session),
      prodigiKeyConfigured: bindings.prodigiKeyConfigured,
      now: new Date().toISOString(),
      createOrder: printProvider().placeOrder,
      assetUrlSigner: assetUrlSigner(),
      siteUrl: siteUrl(),
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

async function handleRevocation(event: RevocationEvent, store: OrdersStore) {
  // Both branches resolve to a payment intent; the dispute needs one extra hop
  // because its event names a Charge, not a PaymentIntent.
  let paymentIntent: string | null | undefined;
  if (event.kind === "charge-refunded") {
    const partial = partialRefundAmounts({
      amount: event.amount,
      amountRefunded: event.amountRefunded,
    });
    if (partial) {
      console.error(
        JSON.stringify({
          event: "order.partial-refund",
          paymentIntent: event.paymentIntent,
          amount: partial.amount,
          amountRefunded: partial.amountRefunded,
        }),
      );
      return NextResponse.json({ received: true, ignored: "partial-refund" });
    }
    paymentIntent = event.paymentIntent;
  } else {
    paymentIntent = await paymentIntentForDispute(
      { charge: event.dispute.charge },
      stripeSessionLookupPort(),
    );
  }

  try {
    const result = await revokeOrderByPaymentIntent({
      store,
      status: event.kind === "charge-refunded" ? "refunded" : "disputed",
      paymentIntent,
      now: new Date().toISOString(),
      stripe: stripeSessionLookupPort(),
      cancel: prodigiCancel(),
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

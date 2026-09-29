import { NextResponse } from "next/server";
import { fulfillCheckoutSession } from "@/lib/fulfillment";
import {
  readStripeEvent,
  type StripeCheckoutSession,
} from "@/lib/stripe-event";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat. Not a separate Node server.
export const runtime = "nodejs";

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing-signature" }, { status: 400 });
  }

  const bindings = await readWorkerBindings();
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

  if (!HANDLED.has(event.type)) {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  if (!bindings.ORDERS) {
    console.error("stripe webhook unconfigured: ORDERS KV binding missing");
    return NextResponse.json({ error: "orders-kv-unavailable" }, { status: 503 });
  }

  const session = event.data.object as StripeCheckoutSession;

  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null;

  try {
    const result = await fulfillCheckoutSession({
      kv: bindings.ORDERS,
      sessionId: session.id ?? "",
      paymentStatus: session.payment_status ?? null,
      currency: session.currency ?? null,
      amountTotal: session.amount_total ?? null,
      metadata: session.metadata ?? null,
      shippingDetails,
      customerEmail: session.customer_details?.email ?? null,
      customerPhone: session.customer_details?.phone ?? null,
      prodigiKeyConfigured: bindings.prodigiKeyConfigured,
      now: new Date().toISOString(),
    });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (e) {
    // The bare catch used to answer "orders-kv-unavailable" for *any* throw.
    // That is the one thing this handler must not do: a bug in fulfillment, a
    // bad PRODIGI_API_BASE, or a KV write failure all presented as a missing
    // binding, so the log pointed at the wrong subsystem entirely. Log the real
    // error and keep 5xx so Stripe redelivers rather than dropping paid money.
    console.error("stripe webhook fulfillment failed", e);
    return NextResponse.json(
      { error: "fulfillment-failed" },
      { status: 500 },
    );
  }
}

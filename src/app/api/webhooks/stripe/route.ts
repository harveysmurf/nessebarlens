import { NextResponse } from "next/server";
import { fulfillCheckoutSession } from "@/lib/fulfillment";
import { readStripeEvent } from "@/lib/stripe-event";
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
  if (!bindings.webhookSecret) {
    return NextResponse.json(
      { error: "stripe-webhook-unconfigured" },
      { status: 500 },
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
    return NextResponse.json({ error: "orders-kv-unavailable" }, { status: 500 });
  }

  const session = event.data.object as {
    id?: string;
    payment_status?: string | null;
    currency?: string | null;
    amount_total?: number | null;
    metadata?: Record<string, string> | null;
  };

  try {
    const result = await fulfillCheckoutSession({
      kv: bindings.ORDERS,
      sessionId: session.id ?? "",
      paymentStatus: session.payment_status ?? null,
      currency: session.currency ?? null,
      amountTotal: session.amount_total ?? null,
      metadata: session.metadata ?? null,
      prodigiKeyConfigured: bindings.prodigiKeyConfigured,
      now: new Date().toISOString(),
    });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch {
    return NextResponse.json({ error: "orders-kv-unavailable" }, { status: 500 });
  }
}

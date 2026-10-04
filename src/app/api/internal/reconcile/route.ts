/**
 * POST /api/internal/reconcile — operator/cron entry for #116.
 *
 * Guarded by `x-reconcile-secret`. A missing or mismatched secret is 404, not
 * 401: an unauthenticated caller should not learn that the endpoint exists. An
 * absent RECONCILE_SECRET in the Worker env is 503 and logs loudly — that is a
 * deploy-time fact, not a caller mistake.
 *
 * Invoked by `.github/workflows/reconcile.yml` on a schedule (and by
 * workflow_dispatch after rotating a Prodigi key). Not a Cloudflare Cron
 * Trigger — see reconcile.ts.
 */

import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/private-headers";
import { readWorkerBindings } from "@/lib/worker-bindings";
import { timingSafeEqualString } from "@/lib/crypto-hex";
import { getConfig } from "@/lib/config";
import { getStripe } from "@/lib/stripe";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/lib/orders-store";
import {
  reconcileOrders,
  type ReconcileSession,
  type ReconcileStripe,
} from "@/lib/reconcile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECONCILE_SECRET_HEADER = "x-reconcile-secret";

export async function POST(request: Request) {
  const bindings = await readWorkerBindings();

  if (!bindings.reconcileSecret) {
    console.error(
      "reconcile unconfigured: RECONCILE_SECRET is missing or empty",
    );
    return NextResponse.json(
      { error: "reconcile-unconfigured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const provided = request.headers.get(RECONCILE_SECRET_HEADER) ?? "";
  if (!timingSafeEqualString(bindings.reconcileSecret, provided)) {
    return NextResponse.json(
      { error: "not-found" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  if (!bindings.ORDERS_DB) {
    console.error("reconcile unconfigured: ORDERS_DB binding missing");
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS, headers: NO_STORE_HEADERS },
    );
  }

  const config = getConfig();
  try {
    const summary = await reconcileOrders({
      store: bindings.ORDERS_DB,
      stripe: liveReconcileStripe(),
      prodigiKeyConfigured: bindings.prodigiKeyConfigured,
      downloadLimits: {
        ttlSeconds: config.download.tokenTtlSeconds,
        maxDownloads: config.download.maxDownloads,
      },
    });
    console.error(JSON.stringify({ event: "order.reconcile", ...summary }));
    return NextResponse.json(summary, {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  } catch (e) {
    console.error("reconcile failed", e);
    return NextResponse.json(
      { error: "reconcile-failed" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

function liveReconcileStripe(): ReconcileStripe {
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

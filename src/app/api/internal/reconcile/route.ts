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
import { reconcileStripe } from "@/lib/container";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/lib/orders-store";
import { reconcileOrders } from "@/lib/reconcile";

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
      stripe: reconcileStripe(),
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

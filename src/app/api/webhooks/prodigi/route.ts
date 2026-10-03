/**
 * POST /api/webhooks/prodigi — Prodigi CloudEvent callbacks (#117).
 *
 * Mirrors the Stripe webhook route: force-dynamic, nodejs runtime, raw body,
 * auth before any effect. Prodigi signs nothing, so authentication is our
 * bearer token alone (`Authorization: Bearer <PRODIGI_WEBHOOK_TOKEN>`).
 *
 * 503 when the token is unset — "unconfigured is a deploy-time fact",
 * distinct from 401 bad auth, same reasoning the Stripe route documents for
 * a missing STRIPE_WEBHOOK_SECRET. 401 on mismatch or absence of the header.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/lib/crypto-hex";
import { sendEmailFromApiKey } from "@/lib/email";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/lib/orders-store";
import { handleProdigiCallback } from "@/lib/prodigi-callback";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat. Not a separate Node server.
export const runtime = "nodejs";

const BEARER_PREFIX = "Bearer ";

/**
 * Extract the bearer token from an Authorization header. Timing-safe compare
 * happens against the configured token; this only peels the scheme.
 */
function bearerToken(header: string | null): string {
  if (!header || !header.startsWith(BEARER_PREFIX)) return "";
  return header.slice(BEARER_PREFIX.length);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const bindings = await readWorkerBindings();

  // 503, not 500: "we are not configured" is a deploy-time fact a human has
  // to fix, and it must be distinguishable in the logs from "Prodigi sent a
  // bad token". 5xx either way would make Prodigi retry; 503 names the cause.
  if (!bindings.prodigiWebhookToken) {
    console.error(
      "prodigi webhook unconfigured: PRODIGI_WEBHOOK_TOKEN is missing or empty",
    );
    return NextResponse.json(
      { error: "prodigi-webhook-unconfigured" },
      { status: 503 },
    );
  }

  const provided = bearerToken(request.headers.get("authorization"));
  if (!timingSafeEqualString(bindings.prodigiWebhookToken, provided)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!bindings.ORDERS_DB) {
    console.error("prodigi webhook unconfigured: ORDERS_DB binding missing");
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS },
    );
  }

  try {
    const result = await handleProdigiCallback({
      rawBody,
      store: bindings.ORDERS_DB,
      sendEmail: sendEmailFromApiKey(bindings.resendApiKey),
      now: new Date().toISOString(),
    });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (e) {
    console.error("prodigi webhook failed", e);
    return NextResponse.json(
      { error: "prodigi-callback-failed" },
      { status: 500 },
    );
  }
}

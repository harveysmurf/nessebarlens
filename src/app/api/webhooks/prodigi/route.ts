/**
 * POST /api/webhooks/prodigi — Prodigi CloudEvent callbacks (#117).
 *
 * Mirrors the Stripe webhook route: force-dynamic, nodejs runtime, raw body,
 * auth before any effect. Prodigi signs nothing and the v4 callback reference
 * offers no auth header, so authentication is our shared token passed as the
 * `?token=` query param on the registered callback URL. An
 * `Authorization: Bearer` header is still accepted so a hand-rolled curl or a
 * future Prodigi auth feature keeps working, but the URL is the primary path.
 *
 * 503 when the token is unset — "unconfigured is a deploy-time fact",
 * distinct from 401 bad auth, same reasoning the Stripe route documents for
 * a missing STRIPE_WEBHOOK_SECRET. 401 on mismatch or absence of the token.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/domain/pricing/crypto-hex";
import { sendEmailFromApiKey } from "@/domain/ordering/email";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/domain/ordering/orders-store";
import { handleProdigiCallback } from "@/infrastructure/prodigi/prodigi-callback";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat. Not a separate Node server.
export const runtime = "nodejs";

const BEARER_PREFIX = "Bearer ";

/**
 * Pull the token out of the request: the query param Prodigi is configured to
 * send first, falling back to a bearer header. Timing-safe compare happens
 * against the configured token; this only locates the candidate.
 */
function providedToken(request: Request): string {
  const fromQuery = new URL(request.url).searchParams.get("token") ?? "";
  if (fromQuery) return fromQuery;
  const header = request.headers.get("authorization");
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

  const provided = providedToken(request);
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

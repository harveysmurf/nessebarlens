import { NextResponse } from "next/server";
import { resolveDownload } from "@/lib/order-decision";
import { readOrderRecord } from "@/lib/order-corrupt";
import {
  ORDERS_KV_UNAVAILABLE_ERROR,
  ORDERS_KV_UNAVAILABLE_STATUS,
} from "@/lib/orders-kv";
import {
  NO_REFERRER_HEADERS,
  NO_STORE_HEADERS,
} from "@/lib/private-headers";
import { redeemDownloadToken } from "@/lib/download-token";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves the full-resolution master, against a download token and nothing else
 * (#111).
 *
 * The credential is the token, not the Checkout Session id. The id sits in the
 * success URL, so it reaches browser history and the `Referer` header of
 * anything the page loads, and it carries no expiry and no download count. The
 * id still identifies the order; the token grants the file; they are stored
 * under separate keys, so leaking one does not hand over the other.
 *
 * The check order is load-bearing: token first, then the order record, then
 * `resolveDownload`. So a revoked order still ends at `resolveDownload` — the
 * one place that knows about refunds and disputes — rather than at a second
 * copy of that rule here. And the decrement happens *before* any bytes are
 * read, so a stream that dies mid-flight still cost a download.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("token") ?? "";

  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS) {
    return NextResponse.json(
      { error: ORDERS_KV_UNAVAILABLE_ERROR },
      { status: ORDERS_KV_UNAVAILABLE_STATUS, headers: PRIVATE_HEADERS },
    );
  }

  const redeemed = await redeemDownloadToken({
    kv: bindings.ORDERS,
    token,
  });
  if (!redeemed.ok) {
    return NextResponse.json(
      { error: redeemed.error },
      { status: redeemed.status, headers: PRIVATE_HEADERS },
    );
  }

  const sessionId = redeemed.record.sessionId;
  let raw: string | null;
  try {
    raw = await bindings.ORDERS.get(sessionId);
  } catch {
    return NextResponse.json(
      { error: ORDERS_KV_UNAVAILABLE_ERROR },
      { status: ORDERS_KV_UNAVAILABLE_STATUS, headers: PRIVATE_HEADERS },
    );
  }

  if (raw === null) {
    return NextResponse.json(
      { status: "processing" },
      { status: 202, headers: PRIVATE_HEADERS },
    );
  }

  const order = readOrderRecord(raw, sessionId, "download");
  if (!order) {
    return NextResponse.json(
      { error: "corrupt-order" },
      { status: 500, headers: PRIVATE_HEADERS },
    );
  }

  const resolved = await resolveDownload(order, bindings.MASTERS);
  if (resolved.kind === "json") {
    return NextResponse.json(resolved.body, {
      status: resolved.status,
      headers: PRIVATE_HEADERS,
    });
  }

  return new NextResponse(resolved.body, {
    status: 200,
    headers: {
      "Content-Type": resolved.contentType,
      "Content-Length": String(resolved.size),
      "Content-Disposition": `attachment; filename="${resolved.filename}"`,
      ...PRIVATE_HEADERS,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * `no-referrer` in addition to the shared no-store.
 *
 * The token is in this URL. `Referrer-Policy: no-referrer` means a browser
 * hitting this endpoint never names the token to whatever the response links
 * to, or to anything the page then loads — the one header that stops the
 * credential travelling with the request.
 */
const PRIVATE_HEADERS = {
  ...NO_STORE_HEADERS,
  ...NO_REFERRER_HEADERS,
} as const;

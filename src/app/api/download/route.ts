import { NextResponse } from "next/server";
import {
  isCheckoutSessionId,
  parseOrderRecord,
  resolveDownload,
} from "@/lib/fulfillment";
import { NO_STORE_HEADERS } from "@/lib/private-headers";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
  if (!isCheckoutSessionId(sessionId)) {
    return NextResponse.json(
      { error: "invalid-session-id" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS) {
    return NextResponse.json(
      { error: "orders-kv-unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  let raw: string | null;
  try {
    raw = await bindings.ORDERS.get(sessionId);
  } catch {
    return NextResponse.json(
      { error: "orders-kv-unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (raw === null) {
    return NextResponse.json(
      { status: "processing" },
      { status: 202, headers: NO_STORE_HEADERS },
    );
  }

  const order = parseOrderRecord(raw);
  if (!order || order.sessionId !== sessionId) {
    return NextResponse.json(
      { error: "corrupt-order" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const resolved = await resolveDownload(order, bindings.MASTERS);
  if (resolved.kind === "json") {
    return NextResponse.json(resolved.body, {
      status: resolved.status,
      headers: NO_STORE_HEADERS,
    });
  }

  return new NextResponse(resolved.body, {
    status: 200,
    headers: {
      "Content-Type": resolved.contentType,
      "Content-Length": String(resolved.size),
      "Content-Disposition": `attachment; filename="${resolved.filename}"`,
      ...NO_STORE_HEADERS,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

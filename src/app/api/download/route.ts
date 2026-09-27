import { NextResponse } from "next/server";
import {
  isCheckoutSessionId,
  parseOrderRecord,
  resolveDownload,
} from "@/lib/fulfillment";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
  if (!isCheckoutSessionId(sessionId)) {
    return NextResponse.json(
      { error: "invalid-session-id" },
      { status: 400, headers: NO_STORE },
    );
  }

  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS) {
    return NextResponse.json(
      { error: "orders-kv-unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }

  let raw: string | null;
  try {
    raw = await bindings.ORDERS.get(sessionId);
  } catch {
    return NextResponse.json(
      { error: "orders-kv-unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }

  if (raw === null) {
    return NextResponse.json(
      { status: "processing" },
      { status: 202, headers: NO_STORE },
    );
  }

  const order = parseOrderRecord(raw);
  if (!order || order.sessionId !== sessionId) {
    return NextResponse.json(
      { error: "corrupt-order" },
      { status: 500, headers: NO_STORE },
    );
  }

  const resolved = await resolveDownload(order, bindings.MASTERS);
  if (resolved.kind === "json") {
    return NextResponse.json(resolved.body, {
      status: resolved.status,
      headers: NO_STORE,
    });
  }

  return new NextResponse(resolved.body, {
    status: 200,
    headers: {
      "Content-Type": resolved.contentType,
      "Content-Length": String(resolved.size),
      "Content-Disposition": `attachment; filename="${resolved.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

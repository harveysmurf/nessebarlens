import { NextResponse } from "next/server";
import { isCheckoutSessionId, orderViewState } from "@/lib/order-decision";
import { readOrderRecord } from "@/lib/order-corrupt";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  ORDERS_STORE_UNAVAILABLE_STATUS,
} from "@/lib/orders-store";
import { NO_STORE_HEADERS } from "@/lib/private-headers";
import { readWorkerBindings } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only order state for the success page's polling loop (#103).
 *
 * Returns the same `OrderViewState` the success page renders from, so the two
 * cannot disagree about whether a download is ready. It deliberately does NOT
 * touch the masters bucket: /api/download is the only thing that reads the
 * full-resolution file, and this endpoint exists to answer "is it ready yet"
 * without pulling bytes to answer it.
 *
 * The state names are the whole contract, and they are the same closed set the
 * page renders — a client that switches on them keeps working if a case is
 * added later, because the fallback is "keep waiting", not "show a download".
 */
export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
  if (!isCheckoutSessionId(sessionId)) {
    return NextResponse.json(
      { error: "invalid-session-id" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS_DB) {
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS, headers: NO_STORE_HEADERS },
    );
  }

  let raw: string | null;
  try {
    raw = await bindings.ORDERS_DB.getOrder(sessionId);
  } catch {
    return NextResponse.json(
      { error: ORDERS_STORE_UNAVAILABLE_ERROR },
      { status: ORDERS_STORE_UNAVAILABLE_STATUS, headers: NO_STORE_HEADERS },
    );
  }

  // No record yet means the webhook has not written one. That is the ordinary
  // first seconds after payment, not an error, so it is a 200 with the pending
  // state rather than the 404 a missing key looks like elsewhere.
  if (raw === null) {
    return NextResponse.json(
      { state: "digital-pending" as const },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  const order = readOrderRecord(raw, sessionId, "order-status");
  if (!order) {
    return NextResponse.json(
      { error: "corrupt-order" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    { state: orderViewState(order) },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

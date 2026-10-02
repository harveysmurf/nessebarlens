import {
  isCheckoutSessionId,
  orderViewState,
  type OrderViewState,
} from "@/lib/order-decision";
import { readOrderRecord } from "@/lib/order-corrupt";
import { downloadLinkForSession } from "@/lib/download-token";
import { readWorkerBindings } from "@/lib/worker-bindings";

/**
 * The order state the success page renders from, widened with the two cases
 * that exist before any KV lookup can answer: no reference in the URL at all,
 * and a reference that is not shaped like a Checkout Session.
 *
 * "processing" covers every case where we cannot yet assert anything about the
 * order — including a missing KV binding or a throwing get(). The page says
 * "we are preparing your download" there, which is a claim we can actually make,
 * where a 500 would tell a customer with money already taken that their payment
 * failed.
 */
export type CheckoutPageState =
  | "missing-session"
  | "invalid-session"
  | "unavailable"
  | "processing"
  | OrderViewState
  /**
   * The order is paid and ready, but there is no download token for it — the
   * page cannot hand over a link, because the only credential that grants the
   * file is the token (#111). Reachable for records stored before tokens
   * existed; never minted lazily here, because the session id in this URL must
   * not be able to mint itself a download.
   */
  | "digital-no-token";

/**
 * Read the order behind a Checkout Session for the success page.
 *
 * Never throws. A page that 500s after Stripe took the money is worse than one
 * that says "preparing", so every failure below degrades to a state the page can
 * render honestly rather than propagating.
 */
export async function resolveCheckoutPageState(
  sessionId: string | undefined,
): Promise<CheckoutPageState> {
  if (!sessionId) return "missing-session";

  // Parsed here as well as in the download route rather than trusting the
  // caller: this value arrives from the query string, and this function is the
  // only thing between it and a KV read under a key we did not validate.
  if (!isCheckoutSessionId(sessionId)) return "invalid-session";

  // No try/catch around readWorkerBindings: it already swallows a throwing env
  // reader and returns no ORDERS rather than propagating, so a catch here would
  // be a branch nothing can reach. The KV get() below is the call that really
  // can throw at runtime, and that one is handled.
  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS) return "processing";

  let raw: string | null;
  try {
    raw = await bindings.ORDERS.get(sessionId);
  } catch {
    return "processing";
  }

  // No record yet is the ordinary first seconds after payment: the webhook has
  // not run. Not an error, and deliberately indistinguishable here from the
  // degraded cases above, because the page says the same thing for all of them.
  if (raw === null) return "processing";

  const order = readOrderRecord(raw, sessionId, "page");
  if (!order) return "unavailable";

  const state = orderViewState(order);
  if (state !== "digital-ready") return state;

  const link = await downloadLinkForSession(bindings.ORDERS, sessionId);
  return link ? state : "digital-no-token";
}

/**
 * The download link for the page, or null when there is no usable token.
 *
 * A separate read from the state resolver rather than widening its return
 * type: the poller endpoint answers with `OrderViewState` alone and must keep
 * doing so, and the token is never part of a state name. Returning a link
 * rather than a raw token means the page cannot assemble the URL itself and
 * drift from the one shape the route accepts.
 *
 * Known, and deliberately not restructured: the page reads the index twice
 * (once in `resolveCheckoutPageState`, once here), so a token expiring between
 * the two reads renders the `processing` branch, whose poller answers state
 * only and cannot recover a link. Reaching it needs a TTL configured to lapse
 * mid-render. Threading the record through instead would mean widening the
 * resolver's return type for a case that is a bad config, not a live path.
 */
export async function resolveCheckoutDownloadLink(
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId || !isCheckoutSessionId(sessionId)) return null;
  const bindings = await readWorkerBindings();
  if (!bindings.ORDERS) return null;
  return downloadLinkForSession(bindings.ORDERS, sessionId);
}


/**
 * Best-effort Prodigi order cancellation.
 *
 * Cancelling a print is NOT the stripe webhook's contract. The webhook's
 * contract is "revoke the customer's access to what they no longer own", and
 * that is entirely local: it is one KV write. Prodigi cancellation is a
 * courtesy to the customer and a cost saving to us, and it is allowed to fail
 * — so every function here returns a result rather than throwing, and the
 * caller logs and answers 200 either way.
 *
 * Why it is best-effort rather than authoritative: which stages are still
 * cancellable, and whether a dispatched order can be recalled, are Prodigi's
 * call. Probing the sandbox (#298) showed a completed order answers
 * `ActionNotAvailable`, so a late cancel succeeding is not something the caller
 * may assume. Guessing "cancelled" into a record would be worse than admitting
 * we do not know: a human reading `order.prodigi-cancel-failed` with the stage
 * attached can decide, whereas a record claiming a cancellation that never
 * happened cannot be corrected later by anyone.
 */

import { prodigiUrl } from "./prodigi-config";
import { prodigiConfig } from "../config/config";
import type { CancelProdigiOrder } from "../../domain/ordering/print-provider";

/** A thrown value that is not an Error still has to name the failure. */
function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/**
 * Prodigi order ids are opaque; the only thing we must not do is interpolate
 * something that could escape the path segment. Mirrors the defensive shape
 * used for the slug patterns elsewhere in this codebase.
 */
const PRODIGI_ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeProdigiOrderId(value: unknown): value is string {
  return typeof value === "string" && PRODIGI_ORDER_ID_PATTERN.test(value);
}

/**
 * The order's own cancel endpoint, built from an already-validated base.
 *
 * `base` is the host readProdigiConfig returned (trailing slash stripped), so
 * this never re-reads the environment and never throws on an unconfigured
 * deployment — the caller has already failed closed on the read before reaching
 * here. The one thing it still refuses is an order id that could escape its
 * path segment.
 *
 * The v4 cancel action is under `/actions/cancel`; the previous `/cancel`
 * answered `EndpointDoesNotExist` (HTTP 404) against the sandbox, so every
 * cancellation was silently a no-op (#298).
 */
export function prodigiCancelUrl(prodigiOrderId: string, base: string): string {
  if (!isSafeProdigiOrderId(prodigiOrderId)) {
    throw new Error("unsafe Prodigi order id");
  }
  return prodigiUrl(base, `v4.0/orders/${prodigiOrderId}/actions/cancel`);
}

/**
 * Session id rides along so the log line an operator reads can name the order
 * without a second lookup. It is never sent to Prodigi — `merchantReference`
 * is already the session id on their side.
 */
export const cancelProdigiOrder: CancelProdigiOrder = async (input) => {
  const config = prodigiConfig();
  if (!config.ok) {
    return {
      ok: false,
      status: null,
      reason: "prodigi-cancel-unconfigured",
      message: config.message,
    };
  }

  let url: string;
  try {
    url = prodigiCancelUrl(input.prodigiOrderId, config.base);
  } catch (e) {
    return {
      ok: false,
      status: null,
      reason: "prodigi-cancel-unconfigured",
      message: errorMessage(e, "prodigi-unconfigured"),
    };
  }
  const apiKey = config.key;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ merchantReference: input.sessionId }),
    });
  } catch (e) {
    return {
      ok: false,
      status: null,
      reason: "prodigi-cancel-unreachable",
      message: errorMessage(e, "network-error"),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: `prodigi-cancel-http-${res.status}`,
      message: `Prodigi cancel HTTP ${res.status}`,
    };
  }

  return { ok: true, status: res.status };
};
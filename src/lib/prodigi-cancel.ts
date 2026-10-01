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
 * Why it is best-effort rather than authoritative: Prodigi's cancel semantics
 * (which stages are still cancellable, whether a dispatched order can be
 * recalled) are documented at docs.prodigi.com, which did not resolve from the
 * box this was written on, and there is no sandbox key here to probe. Guessing
 * "cancelled" into a record would be worse than admitting we do not know: a
 * human reading `order.prodigi-cancel-failed` with the stage attached can
 * decide, whereas a record claiming a cancellation that never happened cannot
 * be corrected later by anyone.
 */

import { prodigiApiKey, prodigiOrdersUrl } from "./config";

/** A thrown value that is not an Error still has to name the failure. */
function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export type ProdigiCancelResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; reason: string; message: string };

export type CancelProdigiOrder = (input: {
  prodigiOrderId: string;
  sessionId: string;
}) => Promise<ProdigiCancelResult>;

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
 * The order's own cancel endpoint.
 *
 * `env` is optional and forwards undefined rather than defaulting to
 * process.env here: prodigiOrdersUrl() already owns that default, and it is in
 * config.ts, which is where the AST guard expects the one read. A default in
 * this signature would be a second, invisible way to reach the environment.
 */
export function prodigiCancelUrl(
  prodigiOrderId: string,
  env?: Record<string, unknown>,
): string {
  if (!isSafeProdigiOrderId(prodigiOrderId)) {
    throw new Error("unsafe Prodigi order id");
  }
  return `${prodigiOrdersUrl(env)}/${prodigiOrderId}/cancel`;
}

/**
 * Session id rides along so the log line an operator reads can name the order
 * without a second lookup. It is never sent to Prodigi — `merchantReference`
 * is already the session id on their side.
 */
export const cancelProdigiOrder: CancelProdigiOrder = async (input) => {
  let url: string;
  let apiKey: string;
  try {
    url = prodigiCancelUrl(input.prodigiOrderId);
    apiKey = prodigiApiKey();
  } catch (e) {
    return {
      ok: false,
      status: null,
      reason: "prodigi-cancel-unconfigured",
      message: errorMessage(e, "prodigi-unconfigured"),
    };
  }

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
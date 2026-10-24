/**
 * The bounded Prodigi call, and what a failed one means.
 *
 * Four call sites — the quote, the order we create, the order we read back and
 * the callback's live lookup — each wrote the same rule: a call with a deadline,
 * and a catch block that turns the deadline into "prodigi-timeout" and any other
 * network failure into "prodigi-unavailable".
 *
 * The rule is the one that decides whether the customer gets their print. A
 * timeout may mean the order was created and the answer lost, which is why the
 * idempotency key on the session id makes a retry safe; any other network
 * failure is Prodigi being unreachable. Written four times, the four copies are
 * four chances to answer the two differently, and the copy that answers the
 * timeout like an ordinary outage is the one that strands a paid order.
 *
 * The caller's own timeout message stays with the caller: what a timeout means
 * to a customer waiting on a quote is not what it means to a webhook that has
 * to answer Stripe inside its window.
 */

import { isProdigiTimeout } from "../../domain/ordering/prodigi-timeout";
import { PRODIGI_FAILURE_REASONS } from "../../domain/ordering/prodigi-policy";

/** What a Prodigi call that never answered means. */
export type ProdigiCallFailure = {
  /** How the failure is retried — the same two values every call site used. */
  kind: "timeout" | "server";
  /** Why it failed, in the domain's own vocabulary. */
  reason:
    | typeof PRODIGI_FAILURE_REASONS.timeout
    | typeof PRODIGI_FAILURE_REASONS.unavailable;
  /** What an operator reads. */
  message: string;
};

/** The call's outcome: the response, or the failure it stands for. */
export type ProdigiCall =
  | { ok: true; response: Response }
  | { ok: false; failure: ProdigiCallFailure };

export async function prodigiCall(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<ProdigiCall> {
  try {
    return { ok: true, response: await fetch(url, { ...init, signal }) };
  } catch (e) {
    // A timeout and any other network failure both return rather than throw:
    // "Prodigi quote timed out" tells an operator to look at Prodigi's latency
    // while "fetch failed" tells them nothing about which deadline was hit.
    if (isProdigiTimeout(e, signal)) {
      return {
        ok: false,
        failure: {
          kind: "timeout",
          reason: PRODIGI_FAILURE_REASONS.timeout,
          message: timeoutMessage,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: "server",
        reason: PRODIGI_FAILURE_REASONS.unavailable,
        message: e instanceof Error ? e.message : "network-error",
      },
    };
  }
}

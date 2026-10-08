/**
 * Prodigi retry policy, in the domain layer (#3, DDD).
 *
 * `order-decision.ts` (domain) and `fulfillment.ts` need to ask "may we retry
 * this failure?" — a domain question about the order, not a fact about the
 * vendor's configuration. The predicate and the reason union live here so the
 * pure decision modules import a domain module rather than infrastructure,
 * which is what the dependency guard (#4) checks. `prodigi-config.ts` imports
 * the reason type and produces these values, but does not own them.
 */

/**
 * Why a Prodigi call could not be made or completed.
 *
 * The retry decision (`kind`) and the diagnosis (`reason`) are deliberately
 * separate axes. Auth and rate-limit failures share the same *retry* behaviour
 * but are different operational problems, so they get different reasons — the
 * stored record has to say which one it was, or "prodigi-error" tells nobody
 * whether to rotate a key or back off.
 */
export type ProdigiFailureReason =
  /** 401/403 — our key is wrong, revoked, or pointed at the wrong host. */
  | "prodigi-auth-error"
  /** 429 — we are being throttled; retrying later is correct. */
  | "prodigi-rate-limit"
  /** 5xx — Prodigi is down or erroring. */
  | "prodigi-unavailable"
  /**
   * Prodigi accepted the connection and then went quiet past our deadline
   * (#104). Distinct from prodigi-unavailable because the answer differs: an
   * unreachable Prodigi is worth retrying later, whereas a timeout may mean the
   * order was created and the response lost — which is exactly what the
   * idempotency key on sessionId is for, so a redelivery is safe and is the
   * only way the customer gets their print.
   */
  | "prodigi-timeout"
  /** 4xx that is our fault and will never succeed on retry (bad request body). */
  | "prodigi-validation-error"
  /** 2xx with no order id in the body — a contract change, not a status code. */
  | "prodigi-error"
  /**
   * We hold paid money but cannot sign the master URL, so there is no asset to
   * send. Distinct from prodigi-unavailable: Prodigi was never contacted.
   */
  | "prodigi-asset-unconfigured"
  /**
   * This deployment has no usable Prodigi API key, or PRODIGI_API_BASE is not
   * an allowed host. Prodigi was never contacted. Retryable: the key is
   * deployment config, and a redeploy inside Stripe's redelivery window
   * (~3 days) is enough to place the order.
   */
  | "prodigi-unconfigured"
  /**
   * Prodigi already holds an order for this idempotency key, and it was built by
   * a *different* deployment: its asset URL or callback URL is on another
   * origin than ours (#193). Environments share one Prodigi namespace, so the
   * first POST defines the order forever and we would otherwise record a signed
   * URL and a callback Prodigi never received. Non-retryable by construction —
   * retrying re-sends the same key and gets the same foreign order back — so
   * the customer is refunded by a human instead of waiting out a redelivery
   * that cannot succeed.
   */
  | "prodigi-order-foreign";

/**
 * Failures we still intend to retry, so the stored order stays eligible for a
 * redelivery instead of being short-circuited as a duplicate.
 */
const RETRYABLE_PRODIGI_REASONS: ReadonlySet<ProdigiFailureReason> =
  new Set<ProdigiFailureReason>([
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-timeout",
    "prodigi-asset-unconfigured",
    "prodigi-unconfigured",
  ]);

export function isRetryableProdigiReason(
  reason: string | null,
): reason is ProdigiFailureReason {
  return (
    reason !== null &&
    RETRYABLE_PRODIGI_REASONS.has(reason as ProdigiFailureReason)
  );
}

/**
 * Operator alert port (#309).
 *
 * A notification to a human that something in our pipeline needs triage — for
 * example, a Prodigi cancel that failed during a Stripe refund, or an order
 * that is unfulfilled past its SLA. The port is generic and event-keyed so the
 * follow-up events (#309 calls out `order.unfulfilled`, `order.stuck`) drop in
 * without reshaping the type: every variant is `{ event, sessionId, summary,
 * details }`, and the variant-specific facts live in `details`.
 *
 * `raise` returns `Promise<void>`: a provider hiccup is surfaced by *throwing*,
 * not by a result code, so the dispatch wrapper (`application/operator-alert.ts`)
 * is the single place that decides "a raised alert must never change the
 * webhook outcome." The wrapper logs `operator-alert.undelivered` when the port
 * is not wired and `operator-alert.failed`/`operator-alert.threw` on a throw —
 * neither propagates onto the revocation/webhook path.
 *
 * The adapter that implements this interface lives in infrastructure
 * (`infrastructure/alerts/email-operator-alerts.ts`); this module is a pure
 * declaration so a rule can be read without touching vendor code.
 *
 * Deliberately absent: enum/namespace/parameter properties (repo rule).
 */

/** The facts a human needs to triage an alert. */
export type OperatorAlert = {
  /** Stable event key — the same string the structured log uses, e.g.
   * `order.prodigi-cancel-failed`. */
  event: string;
  /** Our Checkout Session id, when the alert is rooted in one. */
  sessionId?: string | null;
  /** A one-line human summary of what needs looking at. */
  summary: string;
  /** Variant-specific triage facts (Prodigi order id, stage, HTTP status…). */
  details: Record<string, string | number | null>;
};

/**
 * Raise an operator alert. Implementations must surface a provider failure by
 * throwing (the dispatch wrapper classifies it); the void return lets a
 * successful send and a successful-but-unconfigured send look the same to
 * callers, so "was it sent?" is a log-line question, not an outcome question.
 */
export interface OperatorAlerts {
  raise(alert: OperatorAlert): Promise<void>;
}

/**
 * Shared operator-alert dispatch (#309).
 *
 * The port that sends an alert (`OperatorAlerts.raise`) is declared in
 * `application/ports/operator-alerts.ts`; the Resend adapter that implements it
 * lives in `infrastructure/alerts`. This module is the fire-and-forget caller
 * that wraps every alert site so the *caller's* outcome is never changed:
 *
 *   - no adapter wired (no OPERATOR_ALERT_EMAIL / RESEND_API_KEY) logs
 *     `operator-alert.undelivered` and nothing else,
 *   - a provider hiccup thrown by `raise` logs `operator-alert.failed`,
 *   - an anomalous non-Error throw logs `operator-alert.threw`,
 *
 * Both sites that raise alerts today — the Stripe revocation cancel-failure
 * exit (`application/fulfillment/order-revocation.ts`) — call through this
 * helper, so the log event names and the "never propagate" invariant agree.
 *
 * It lives in `application/`, one inward hop from infrastructure, with no
 * infrastructure import of its own: only the pure port type.
 */

import type { OperatorAlert, OperatorAlerts } from "./ports/operator-alerts";

export async function raiseOperatorAlert(
  alerts: OperatorAlerts | undefined,
  alert: OperatorAlert,
): Promise<void> {
  if (!alerts) {
    console.error(
      JSON.stringify({
        event: "operator-alert.undelivered",
        reason: "operator-alert-email-unconfigured",
        alert,
      }),
    );
    return;
  }
  try {
    await alerts.raise(alert);
  } catch (e) {
    const isError = e instanceof Error;
    console.error(
      JSON.stringify({
        event: isError ? "operator-alert.failed" : "operator-alert.threw",
        alertEvent: alert.event,
        message: isError ? e.message : "alert-threw",
      }),
    );
  }
}

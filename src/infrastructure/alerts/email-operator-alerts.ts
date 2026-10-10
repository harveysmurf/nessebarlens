/**
 * Resend adapter for the OperatorAlerts port (#309).
 *
 * Lives in infrastructure, not domain: it knows the Resend HTTP shape and the
 * alert email format, but the port type it implements is declared in
 * `application/ports/operator-alerts.ts`. The application never imports this
 * module; only `infrastructure/container.ts` wires it into the revocation edge.
 *
 * Reuses the Resend constants and timeout idiom from `domain/ordering/email`
 * and `domain/ordering/prodigi-timeout` — those are pure values and helpers,
 * not the customer-email adapter, so there is no domain→infra import here.
 *
 * `raise` surfaces a provider failure by *throwing* (HTTP error, network error,
 * timeout). The dispatch wrapper in `application/operator-alert.ts` classifies
 * the throw and logs `operator-alert.failed`/`operator-alert.threw` without
 * ever propagating onto the webhook path — so a Resend hiccup cannot turn a
 * revocation into a redelivery.
 */

import type { OperatorAlert, OperatorAlerts } from "../../application/ports/operator-alerts";
import {
  RESEND_EMAILS_URL,
  RESEND_FROM_ADDRESS,
  RESEND_TIMEOUT_MS,
} from "../../domain/ordering/email";
import {
  isProdigiTimeout,
  prodigiTimeoutSignal,
} from "../../domain/ordering/prodigi-timeout";

/**
 * Build the subject and plain-text body for an alert email from the generic
 * alert shape.
 *
 * The body carries the event key and summary first, then the details table, so
 * an operator glancing at the subject line and the first lines identifies the
 * case. No HTML, no master keys, no asset URLs: this is an internal triage note.
 */
export function buildAlertEmail(
  alert: OperatorAlert,
): { subject: string; text: string } {
  const lines: string[] = [
    "Nessebar Lens operator alert",
    "",
    `Event: ${alert.event}`,
    `Summary: ${alert.summary}`,
    "",
    "Details:",
  ];
  for (const [key, value] of Object.entries(alert.details)) {
    lines.push(`  ${key}: ${value === null ? "(none)" : value}`);
  }
  if (alert.sessionId) {
    lines.push("", `Session: ${alert.sessionId}`);
  }
  lines.push("", "— Nessebar Lens");
  return {
    subject: `Operator alert: ${alert.event}`,
    text: lines.join("\n"),
  };
}

/**
 * Build a Resend-backed `OperatorAlerts`, or `undefined` when either the API
 * key or the recipient address is absent.
 *
 * `undefined` is the "not configured" signal the dispatch wrapper logs as
 * `operator-alert.undelivered`. It is never thrown — a missing key is a
 * deploy-time fact, not a runtime failure on a webhook path.
 */
export function createOperatorAlerts(options: {
  apiKey: string | undefined;
  to: string | undefined;
  fetchImpl?: typeof fetch;
  from?: string;
}): OperatorAlerts | undefined {
  if (!options.apiKey || !options.to) return undefined;
  return new EmailOperatorAlerts(
    options.apiKey,
    options.to,
    options.fetchImpl,
    options.from,
  );
}

/**
 * The Resend-backed OperatorAlerts. Constructed by `createOperatorAlerts`;
 * tests can also build one directly with a fake `fetchImpl`.
 */
export class EmailOperatorAlerts implements OperatorAlerts {
  private readonly apiKey: string;
  private readonly to: string;
  private readonly fetchImpl: typeof fetch;
  private readonly from: string;
  constructor(apiKey: string, to: string, fetchImpl?: typeof fetch, from: string = RESEND_FROM_ADDRESS) {
    this.apiKey = apiKey;
    this.to = to;
    this.fetchImpl = fetchImpl ?? fetch;
    this.from = from;
  }

  async raise(alert: OperatorAlert): Promise<void> {
    const email = buildAlertEmail(alert);
    const signal = prodigiTimeoutSignal(RESEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [this.to],
          subject: email.subject,
          text: email.text,
        }),
        signal,
      });
    } catch (e) {
      if (isProdigiTimeout(e, signal)) {
        throw new Error(`Resend timed out after ${RESEND_TIMEOUT_MS}ms`);
      }
      throw e instanceof Error ? e : new Error("resend-network-error");
    }

    if (!res.ok) {
      const detail = await res.text().then(
        (t) => t.slice(0, 200),
        () => "",
      );
      throw new Error(
        `Resend HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}

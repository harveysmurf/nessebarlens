/**
 * Resend adapter for the ContactEmailSender port (#293).
 *
 * Lives in infrastructure: it knows the Resend HTTP shape; the port it
 * implements is declared in `application/ports/contact-email.ts`. It reuses the
 * Resend URL, from-address and timeout constants from `domain/ordering/email`
 * and the timeout idiom from `domain/ordering/prodigi-timeout`, mirroring
 * `infrastructure/alerts/email-operator-alerts.ts` — the constants are shared,
 * the adapter is not, so a change to the order-email body cannot reach here.
 *
 * The visitor's address is set as `reply_to` so the owner can reply straight
 * from the notification. Failure is returned as a result, never thrown: the
 * route turns it into a generic 5xx and logs the diagnostic `message`.
 */

import type {
  ContactEmail,
  ContactEmailSender,
} from "../../application/ports/contact-email";
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
 * Build a Resend-backed contact sender. `apiKey` and `to` are required — the
 * route resolves them from bindings and answers 503 before this is built when
 * either is absent. `from` defaults to the transactional domain address.
 */
export function createContactEmailSender(options: {
  apiKey: string;
  to: string;
  from?: string;
  fetchImpl?: typeof fetch;
}): ContactEmailSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const from = options.from ?? RESEND_FROM_ADDRESS;
  const apiKey = options.apiKey;
  const to = options.to;

  return {
    async send(mail: ContactEmail) {
      const signal = prodigiTimeoutSignal(RESEND_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [to],
            reply_to: mail.replyTo,
            subject: mail.subject,
            text: mail.text,
          }),
          signal,
        });
      } catch (e) {
        if (isProdigiTimeout(e, signal)) {
          return {
            ok: false,
            message: `Resend timed out after ${RESEND_TIMEOUT_MS}ms`,
          };
        }
        return {
          ok: false,
          message: e instanceof Error ? e.message : "resend-network-error",
        };
      }

      if (!res.ok) {
        const detail = await res.text().then(
          (t) => t.slice(0, 200),
          () => "",
        );
        return {
          ok: false,
          message: `Resend HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        };
      }
      return { ok: true, message: "sent" };
    },
  };
}

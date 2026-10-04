/**
 * Customer email port (#117).
 *
 * Resend is the only provider. The port itself is injectable so fulfillment
 * and the Prodigi callback can be tested without a network call, and so an
 * unset API key never throws on a paid path — a missing key is a deploy-time
 * fact, logged once per attempt, not a reason to 5xx a webhook Stripe or
 * Prodigi must redeliver.
 *
 * Idempotency has two layers that cover different windows:
 *
 *   1. The order record's `emailsSent` is the durable claim. The kind is
 *      appended in the same optimistic-locked `transitionOrder` (or the same
 *      `putOrder`) that writes the stage/shipments the email is about, so a
 *      lost lock or a redelivery that already carries the kind never sends.
 *      One gap the claim does not close by itself: `putOrder` is an upsert
 *      (ON CONFLICT DO UPDATE), so two concurrent first deliveries can both
 *      reach the send. Layer 2 is what makes that safe.
 *   2. The Resend `Idempotency-Key: <sessionId>:<kind>` is the backstop for
 *      both residual windows: a successful HTTP call whose response we never
 *      saw, and the concurrent-first-insert race above. Resend will not create
 *      a second message for the same key, so the customer gets exactly one
 *      mail either way.
 *
 * Ordering on every send path: write the claim first, then call `sendEmail`.
 * A failure after the write is logged and ignored — the webhook status and
 * the stored order must not change because the mail provider hiccuped.
 */

import {
  isProdigiTimeout,
  prodigiTimeoutSignal,
} from "./prodigi-config";

/**
 * The three customer-facing kinds. Confirmation and unfulfilled are emitted
 * from our own terminal write in fulfillment; print-shipped is emitted from
 * the Prodigi callback once a fetched shipment says Shipped. Never invent a
 * fourth without extending the record's `emailsSent` parser.
 */
export type EmailKind =
  | "order-confirmation"
  | "print-shipped"
  | "order-unfulfilled"
  /**
   * The operator alert (#195). Not customer-facing: it goes to a fixed ops
   * address and says "we hold paid money and did not fulfil it". It exists
   * because `order.unfulfilled` is a structured log line and nothing else — a
   * paid-unfulfilled order was invisible until the customer replied.
   */
  | "order-ops-alert";

export type SendEmail = (mail: {
  to: string;
  kind: EmailKind;
  subject: string;
  text: string;
  /**
   * Session id rides in so the Resend Idempotency-Key can be
   * `<sessionId>:<kind>` without the copy layer knowing about Resend.
   */
  sessionId: string;
}) => Promise<{ ok: boolean; message: string }>;

/** Resend's documented send endpoint. Named so a host change is one edit. */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/**
 * Bound on the Resend call. Same budget as a Prodigi quote: a hung provider
 * must not outrun the webhook that invoked us. Reuses the Prodigi timeout
 * helpers rather than inventing a second AbortSignal idiom.
 */
export const RESEND_TIMEOUT_MS = 8_000;

/**
 * From-address for every transactional mail. The domain must have Resend's
 * DNS TXT verification; the local part is ours. Not an env var — inventing
 * RESEND_FROM would be a second secret table entry for a value that is the
 * brand, not a credential.
 */
export const RESEND_FROM_ADDRESS = "Nessebar Lens <orders@nessebarlens.com>";

/**
 * Build a Resend-backed sender. `apiKey` is required here; a caller that may
 * see an unset key resolves one through `sendEmailFromApiKey` instead, so the
 * skip is one decision at the wiring site rather than a throw on a paid path.
 */
export function createResendSender(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  from?: string;
}): SendEmail {
  const fetchImpl = options.fetchImpl ?? fetch;
  const from = options.from ?? RESEND_FROM_ADDRESS;
  const apiKey = options.apiKey;

  return async (mail) => {
    const signal = prodigiTimeoutSignal(RESEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `${mail.sessionId}:${mail.kind}`,
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
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
      // Body is diagnostic only; never thrown. A 4xx/5xx from Resend is a
      // reported failure the webhook logs and continues past.
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
  };
}

/**
 * Resolve a SendEmail from an optional API key. Unset/blank → `undefined`
 * so the caller can avoid claiming `emailsSent` for a send that will never
 * happen (fixing the key later must still be able to mail that order).
 * Never throws.
 */
export function sendEmailFromApiKey(
  apiKey: string | undefined,
  fetchImpl?: typeof fetch,
): SendEmail | undefined {
  if (!apiKey) return undefined;
  return createResendSender({ apiKey, fetchImpl });
}

/**
 * Where operator alerts go (#195). A constant, not an env var, for the same
 * reason as `RESEND_FROM_ADDRESS`: it is who we are, not a credential. The
 * sending domain is verified, so delivery does not depend on it.
 */
export const OPS_ALERT_TO = "ops@nessebarlens.com";

/** True when a value is one of the EmailKind literals. */
export function isEmailKind(value: unknown): value is EmailKind {
  return (
    value === "order-confirmation" ||
    value === "print-shipped" ||
    value === "order-unfulfilled" ||
    value === "order-ops-alert"
  );
}

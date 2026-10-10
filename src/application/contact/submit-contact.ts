/**
 * Contact-submission orchestration (#293).
 *
 * The order is the defense: shed a flooding caller first, reject a malformed
 * body second, verify the anti-bot token third — *before* any mail is sent —
 * and only then hand the message to the email port. Every step is an injected
 * port, so this module is pure orchestration and the route stays a thin adapter
 * over HTTP.
 *
 * The outcome is a closed union rather than an HTTP response: `contact-response`
 * owns the status/body mapping, so the same decision is testable without a
 * Request and the route cannot drift from it.
 */

import {
  buildContactEmail,
  parseContactMessage,
  type ContactFieldError,
} from "../../domain/contact/contact-message";
import type { ContactEmailSender } from "../ports/contact-email";
import type { TurnstileVerifier } from "../ports/turnstile";

/**
 * The Workers rate-limit binding's shape. Optional port: absent means the
 * binding was not deployed, which is a missing defense in depth, not a reason to
 * stop serving — Turnstile remains the gate. `limit` resolves `{ success }`
 * where `false` means the caller is over the limit.
 */
export type ContactRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type ContactOutcome =
  | { kind: "ok" }
  | { kind: "invalid"; errors: ContactFieldError[] }
  | { kind: "rate-limited" }
  | { kind: "rejected"; reason: string }
  | { kind: "delivery-failed"; detail: string };

export type ContactDeps = {
  verifyTurnstile: TurnstileVerifier;
  sendEmail: ContactEmailSender;
  rateLimit?: ContactRateLimiter;
};

export type ContactRequestContext = {
  remoteIp?: string;
  /** Rate-limit bucket key; the caller's IP, or a stable fallback. */
  rateLimitKey: string;
};

/**
 * Run one submission to a terminal outcome. Never throws on a provider error:
 * a Turnstile or Resend failure becomes a tagged outcome, because both the
 * verifier and the sender already report failure as a result.
 */
export async function submitContact(
  raw: unknown,
  context: ContactRequestContext,
  deps: ContactDeps,
): Promise<ContactOutcome> {
  if (deps.rateLimit) {
    const { success } = await deps.rateLimit.limit({ key: context.rateLimitKey });
    if (!success) return { kind: "rate-limited" };
  }

  const parsed = parseContactMessage(raw);
  if (!parsed.ok) return { kind: "invalid", errors: parsed.errors };

  const verified = await deps.verifyTurnstile.verify({
    token: parsed.value.turnstileToken,
    remoteIp: context.remoteIp,
  });
  if (!verified.ok) return { kind: "rejected", reason: verified.reason };

  const email = buildContactEmail(parsed.value);
  const sent = await deps.sendEmail.send({
    replyTo: parsed.value.email,
    subject: email.subject,
    text: email.text,
  });
  if (!sent.ok) return { kind: "delivery-failed", detail: sent.message };

  return { kind: "ok" };
}

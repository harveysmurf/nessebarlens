/**
 * Turnstile verification port (#293).
 *
 * The contact route will not send mail until Cloudflare's Siteverify endpoint
 * confirms the widget token. The port is declared here so the route depends on
 * a decision rather than on an HTTP call, and the Cloudflare-shaped adapter
 * lives in `infrastructure/` per the boundary rule.
 *
 * The result is tagged rather than thrown: `reason` is a short internal string
 * for the log line, never the visitor's token and never rendered to them. The
 * route answers every non-ok reason with the same generic message, so a bot
 * cannot probe which check failed. `fail-closed` is the contract — a missing,
 * invalid, expired, reused or unverifiable token is never `ok`.
 */

export type TurnstileVerification =
  | { ok: true }
  | { ok: false; reason: string };

export interface TurnstileVerifier {
  verify(input: { token: string; remoteIp?: string }): Promise<TurnstileVerification>;
}

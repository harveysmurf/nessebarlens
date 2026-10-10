/**
 * Cloudflare Turnstile Siteverify adapter (#293).
 *
 * The only anti-bot check the contact route trusts. It posts the widget token
 * to Cloudflare and returns a tagged result; it never throws and never reports
 * `ok` unless Cloudflare answered 200 with `success: true`.
 *
 * Fail-closed on every edge: a network error, a timeout, a non-2xx, an
 * unparseable body, or `success` that is anything but the boolean `true` all
 * become `{ ok: false }`. Cloudflare reports an expired or already-used token as
 * `success: false` with a `timeout-or-duplicate` error code, so "reject reused
 * tokens" needs no state on our side.
 *
 * Reuses the Prodigi timeout helpers and the order-email timeout budget rather
 * than inventing a second AbortSignal idiom — a hung Siteverify must not outrun
 * the request that invoked it.
 */

import type {
  TurnstileVerification,
  TurnstileVerifier,
} from "../../application/ports/turnstile";
import { RESEND_TIMEOUT_MS } from "../../domain/ordering/email";
import {
  isProdigiTimeout,
  prodigiTimeoutSignal,
} from "../../domain/ordering/prodigi-timeout";

/** Cloudflare's documented server-side validation endpoint. */
export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Build a real Turnstile verifier. `secretKey` is required; the route reads it
 * from the Worker bindings. `fetchImpl` is injectable so tests drive every
 * branch without a network call.
 */
export function createTurnstileVerifier(options: {
  secretKey: string;
  fetchImpl?: typeof fetch;
}): TurnstileVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const secretKey = options.secretKey;

  return {
    async verify({ token, remoteIp }): Promise<TurnstileVerification> {
      const params = new URLSearchParams({ secret: secretKey, response: token });
      if (remoteIp) params.set("remoteip", remoteIp);

      const signal = prodigiTimeoutSignal(RESEND_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal,
        });
      } catch (e) {
        if (isProdigiTimeout(e, signal)) {
          return { ok: false, reason: "siteverify-timeout" };
        }
        return { ok: false, reason: "siteverify-network-error" };
      }

      if (!res.ok) {
        return { ok: false, reason: `siteverify-http-${res.status}` };
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return { ok: false, reason: "siteverify-malformed" };
      }

      const success =
        payload !== null &&
        typeof payload === "object" &&
        (payload as { success?: unknown }).success === true;
      return success ? { ok: true } : { ok: false, reason: "siteverify-failed" };
    },
  };
}

/**
 * Reading the two API payloads the configurator consumes.
 *
 * `res.json()` returns whatever the network produced: a proxy's HTML error
 * page, a 5xx JSON object, a field silently coerced to `null`, a number the
 * edge mangled into `NaN`. The configurator used to `as` both payloads into a
 * hand-written shape, which asserts that the values are the right type rather
 * than checking that they are — so an `NaN` reached the price label and printed
 * as €NaN, and a non-string `url` reached the redirect assignment.
 *
 * These are pure and unit-testable on purpose: each function takes `unknown`,
 * and returns either the narrowed value or nothing, so the caller branches once
 * and the untrusted shape never has to be asserted into existence.
 *
 * Scope is deliberately the fields the UI actually consumes. Validating the
 * whole payload would reject responses the UI could have rendered perfectly
 * well, and the failure mode of a mismatched-but-usable payload is covered by
 * the generic error message rather than a second, near-duplicate validation
 * grammar.
 */
import { HTTPS_URL_PATTERN } from "@/lib/url-patterns";

export type LiveQuote = {
  merchandiseEur: number;
  shippingEur: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A quote is usable only when both amounts are finite numbers. `typeof` alone
 * is not enough: JSON has no NaN, but a hand-built or proxied response can
 * carry one, and `NaN.toFixed(2)` renders as "NaN".
 */
export function isLiveQuote(value: unknown): value is LiveQuote {
  return (
    isRecord(value) &&
    typeof value.merchandiseEur === "number" &&
    Number.isFinite(value.merchandiseEur) &&
    typeof value.shippingEur === "number" &&
    Number.isFinite(value.shippingEur)
  );
}

/**
 * The checkout redirect target, or `null` when the payload does not carry one.
 * The https rule is enforced here rather than at the call site so the value
 * cannot be read, and accidentally navigated to, without passing it first.
 */
export function checkoutUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  if (typeof url !== "string") return null;
  return HTTPS_URL_PATTERN.test(url) ? url : null;
}

/**
 * The server's own error string, when it sent a usable one. Read from
 * `unknown` with its own guard so the error path cannot itself throw — an
 * unreadable payload falls back to the caller's generic message.
 */
export function errorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = value.error;
  return typeof message === "string" && message !== "" ? message : null;
}

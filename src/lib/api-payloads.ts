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
 * Origins Stripe actually hosts Checkout Sessions on. The redirect target is
 * navigated to with `window.location.href`, so the scheme check alone would
 * happily pass `https://evil.example`. Origins are compared as full
 * `scheme://host[:port]` strings — no suffix or `includes` test, because
 * `evil-checkout.stripe.com` and `checkout.stripe.com.evil.example` both sail
 * past those.
 */
const CHECKOUT_REDIRECT_ORIGINS: ReadonlySet<string> = new Set([
  "https://checkout.stripe.com",
]);

/**
 * The checkout redirect target, or `null` when the payload does not carry one.
 * The https-plus-known-origin rule is enforced here rather than at the call
 * site so the value cannot be read, and accidentally navigated to, without
 * passing it first.
 */
export function checkoutUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  if (typeof url !== "string") return null;
  if (!HTTPS_URL_PATTERN.test(url)) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return CHECKOUT_REDIRECT_ORIGINS.has(origin) ? url : null;
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

/**
 * A body that arrived and was not JSON. A distinct value rather than null,
 * because `null` is a legitimate JSON payload and "the server sent HTML" is a
 * different failure from "the server sent JSON null" — the caller reports them
 * differently.
 */
const NOT_JSON: unique symbol = Symbol("not-json");
export type NonJsonBody = typeof NOT_JSON;

/**
 * Read a response body as JSON without ever throwing.
 *
 * `res.json()` rejects on anything that is not JSON, and the configurator
 * called it before checking `res.ok`. A 502 answered by the edge or a proxy
 * with an HTML error page therefore surfaced to the customer as
 * `Unexpected token '<'` — a JavaScript parse error, at a 4px red label under
 * "Shipping estimate", describing our own client rather than the outage that
 * actually happened. Reading the text and parsing it by hand turns the same
 * response into a message naming the status.
 *
 * A body that cannot even be read (a dropped connection) is also NOT_JSON: the
 * status is the only thing left to report, and it is still the useful half.
 */
export async function readJsonResponse(res: Response): Promise<unknown | NonJsonBody> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return NOT_JSON;
  }
  // An empty body is a valid response to some failures and parses to nothing;
  // treating it as "no payload" keeps `errorMessage` on the fallback path
  // instead of reporting a parse failure that never happened.
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

/** Whether a body from readJsonResponse arrived as something other than JSON. */
export function isNonJsonBody(value: unknown): value is NonJsonBody {
  return value === NOT_JSON;
}

/**
 * The message to show for a failed request: the server's own string when it
 * sent one, and the transport status otherwise.
 *
 * Both call sites need this and both got it wrong independently before — one
 * could echo nothing, the other nothing but a parser error — so the fallback
 * carries the status on purpose. "Checkout failed (502)" tells a customer what
 * happened and a developer which request to look for; "Checkout failed" tells
 * neither.
 */
export function requestErrorMessage(
  value: unknown,
  status: number,
  fallback: string,
): string {
  if (isNonJsonBody(value)) return `${fallback} (${status})`;
  return errorMessage(value) ?? `${fallback} (${status})`;
}

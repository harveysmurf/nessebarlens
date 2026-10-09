/**
 * Response headers for private asset responses.
 *
 * Both asset routes — the paid download and the HMAC-gated print-asset
 * stream — declared `const NO_STORE = { "Cache-Control": "private, no-store" }`
 * and then, further down, hand-wrote the same header again inside the stream
 * response rather than spreading the constant they had already defined. Two
 * declarations and two inline spellings for one value on two endpoints that
 * hand out a customer's purchase.
 *
 * It lives here rather than being imported from one of the routes so that
 * whichever route gains a cached response first cannot quietly become the
 * owner of the rule the other one follows.
 */

export const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * The download-token credential must not travel with a request (#111).
 *
 * The download route answers with this alongside the shared no-store, and the
 * checkout success page sets the same policy through next.config.ts, because a
 * credential in a URL is only safe while no `Referer` can name it. Kept as its
 * own constant rather than folded into NO_STORE_HEADERS: no-store is about
 * caching and applies to the print-asset stream too, which has no referrer to
 * leak, whereas this is specifically about not propagating a query string.
 */
export const NO_REFERRER_HEADERS = { "Referrer-Policy": "no-referrer" } as const;

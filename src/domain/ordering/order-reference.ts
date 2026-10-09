/**
 * The short reference a customer quotes in support, derived from the Checkout
 * Session id. One function so the success page and every email print the same
 * value: a customer who sees "OJUOK1S1" on the page and a different string in
 * the email cannot tell they are the same order.
 *
 * The full session id identifies the order and, until #111, doubled as the
 * bearer credential for the download route. It no longer grants a download, but
 * a URL-shaped secret is one a customer pastes into a public thread, so it is
 * printed nowhere customer-facing. Support looks orders up by this suffix, and
 * logs keep the full id.
 */
export function orderReference(sessionId: string): string {
  return sessionId.slice(-8).toUpperCase();
}

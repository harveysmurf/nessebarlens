/**
 * Prodigi timeout helpers, owned by the domain.
 *
 * Moved from `infrastructure/prodigi/prodigi-config.ts` so `domain/ordering/email.ts`
 * no longer needs an `eslint-disable import/no-restricted-paths` to read the
 * timeout signal and predicate. These are not vendor-specific — `AbortSignal.timeout`
 * is a Web API — only the constants are Prodigi-scoped because orders and quotes
 * have different deadlines.
 */

/** Default quote timeout: a customer-facing spinner budget, 8s. */
export const PRODIGI_QUOTE_TIMEOUT_MS = 8_000;

/** Default order-timeout budget: the webhook window, 15s. */
export const PRODIGI_ORDER_TIMEOUT_MS = 15_000;

/**
 * The abort signal for a bounded HTTP call, and the one way to recognise that a
 * call ended because we gave up on it rather than because the provider
 * answered.
 *
 * `AbortSignal.timeout` rather than a manual `AbortController` plus
 * `setTimeout`: it has no timer to keep a request-scoped event loop alive, and
 * it aborts on its own if nobody awaits the promise.
 */
export function prodigiTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * True when a bounded call was ended by our own timeout rather than by the
 * provider's response.
 *
 * Detection is by the signal's own `aborted` flag rather than by the error's
 * name or class — the primary signal check covers every runtime. A defensive
 * second reading catches runtimes that reject with a TimeoutError without
 * marking the signal.
 */
export function isProdigiTimeout(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "TimeoutError"
  );
}

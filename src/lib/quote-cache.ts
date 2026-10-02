/**
 * Short-lived cache for Prodigi quotes on the unauthenticated /api/quote path.
 *
 * /api/checkout re-quotes through the same API key as /api/quote, so one
 * script hammering the public endpoint can push Prodigi into 429 and break
 * checkout for real customers.
 * Quotes for a pinned (SKU, attributes, destination) barely move, so they are
 * cached here for 30 minutes.
 *
 * Two deliberate properties:
 *
 * - Only the two public numbers are cached. merchandiseEur and shippingEur are
 *   exactly what /api/quote returns over the wire; unitCostEur (our wholesale
 *   cost, and with it the 1.2x margin) never enters the cached *value*, so the
 *   cache can never become a place the margin leaks from. The sku does appear
 *   in the cache *key* — the key has to name the product being priced — but the
 *   key is server-side on an `.invalid` origin and is never returned to a
 *   caller. Checkout does not read this cache at all — it quotes live, because
 *   price integrity at the point of payment is worth one upstream call.
 *
 * - A cache failure is never a request failure. `caches.default` is absent in
 *   `next dev` and on a misconfigured deploy; every read and write here
 *   swallows and degrades to "no cache", so the route keeps answering with a
 *   live quote rather than a 500. Losing the cache costs latency and rate
 *   limit, never availability.
 *
 * The Cache API only stores GET requests, so entries are keyed by a synthetic
 * https URL rather than by the POST body.
 */

import type { PhysicalFormat } from "./sku-map";
import { resolveSku } from "./sku-map";
import type { FrameFinish, PrintSize } from "./pricing";

/** 30 minutes. Long enough to absorb a burst, short enough that a real Prodigi
 *  price change reaches the configurator the same afternoon. */
export const QUOTE_CACHE_TTL_SECONDS = 1800;

const CACHE_ORIGIN = "https://quote-cache.invalid";

/** The only two fields /api/quote is allowed to say out loud. */
export type CachedQuote = {
  merchandiseEur: number;
  shippingEur: number;
};

/** The slice of the Workers Cache API this module uses. */
export type QuoteCache = {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
};

/** The runtime cache, or null where the Cache API is not available. */
export function defaultQuoteCache(): QuoteCache | null {
  const caches = (globalThis as { caches?: { default?: QuoteCache } }).caches;
  return caches?.default ?? null;
}

/**
 * The cache key for one quote.
 *
 * Built from the resolved SKU plus its attributes and the destination country,
 * so two configurations that resolve to the same Prodigi product share an entry
 * and two that differ in any attribute Prodigi prices do not. Attributes are
 * sorted so key order can never split one entry into two.
 */
export function quoteCacheKey(input: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  destinationCountryCode: string;
}): string {
  const entry = resolveSku(input.format, input.size, input.frame ?? null);
  const attributes = Object.keys(entry.attributes)
    .sort()
    .map((name) => `${name}=${entry.attributes[name]}`)
    .join(",");
  const query = new URLSearchParams({
    sku: entry.sku,
    attributes,
    country: input.destinationCountryCode,
  });
  return `${CACHE_ORIGIN}/v4.0/quotes?${query.toString()}`;
}

async function cachedQuoteFromResponse(
  response: Response | undefined,
): Promise<CachedQuote | null> {
  if (!response) return null;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") return null;
    const { merchandiseEur, shippingEur } = parsed as Record<string, unknown>;
    if (
      typeof merchandiseEur !== "number" ||
      typeof shippingEur !== "number" ||
      !Number.isFinite(merchandiseEur) ||
      !Number.isFinite(shippingEur)
    ) {
      return null;
    }
    return { merchandiseEur, shippingEur };
  } catch {
    return null;
  }
}

/**
 * The cached quote for this configuration, or null on a miss or any cache
 * error. Callers must treat null as "quote live".
 */
export async function readCachedQuote(
  input: Parameters<typeof quoteCacheKey>[0],
  cache: QuoteCache | null = defaultQuoteCache(),
): Promise<CachedQuote | null> {
  if (!cache) return null;
  try {
    return await cachedQuoteFromResponse(
      await cache.match(new Request(quoteCacheKey(input))),
    );
  } catch {
    return null;
  }
}

/** Stores the two public numbers. Failure to store is not worth reporting. */
export async function writeCachedQuote(
  input: Parameters<typeof quoteCacheKey>[0],
  quote: CachedQuote,
  cache: QuoteCache | null = defaultQuoteCache(),
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(
      new Request(quoteCacheKey(input)),
      new Response(JSON.stringify(quote), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${QUOTE_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    return;
  }
}

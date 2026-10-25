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

import type {
  FramedMount,
  PhysicalFormat,
  PrintPaper,
} from "../../domain/pricing/sku-map";
import { resolveSku } from "../../domain/pricing/sku-map";
import type { FrameFinish, PrintSize } from "../../domain/pricing/pricing";
import { isQuotePayload, type QuotePayload } from "./api-payloads";

/** 30 minutes. Long enough to absorb a burst, short enough that a real Prodigi
 *  price change reaches the configurator the same afternoon. */
export const QUOTE_CACHE_TTL_SECONDS = 1800;

const CACHE_ORIGIN = "https://quote-cache.invalid";

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
 *
 * `mount` (#335) and `paper` (#337) are required: each is part of the SKU, so
 * an omitted one would silently key a different selection as the default
 * product. That omission was the original bug on this path — the mount field
 * was optional and /api/quote left it out. Callers that do not care pass `null`
 * explicitly.
 */
export function quoteCacheKey(input: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  mount: FramedMount | null;
  paper: PrintPaper | null;
  destinationCountryCode: string;
}): string {
  // The mount (#335) and the paper (#337) are in the key because they are in
  // the SKU: CFPM/CFP and FAP/HPR are different products at different prices,
  // so they must not share an entry.
  const entry = resolveSku(
    input.format,
    input.size,
    input.frame ?? null,
    input.mount ?? null,
    input.paper ?? null,
  );
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
): Promise<QuotePayload | null> {
  if (!response) return null;
  try {
    const parsed: unknown = await response.json();
    // The same guard the client applies to the live payload, so a cached
    // entry can never be something the configurator would reject.
    if (!isQuotePayload(parsed)) return null;
    return {
      merchandiseEur: parsed.merchandiseEur,
      shippingEur: parsed.shippingEur,
    };
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
): Promise<QuotePayload | null> {
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
  quote: QuotePayload,
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

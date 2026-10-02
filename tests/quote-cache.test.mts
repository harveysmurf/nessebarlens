import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTE_CACHE_TTL_SECONDS,
  defaultQuoteCache,
  quoteCacheKey,
  readCachedQuote,
  writeCachedQuote,
  type CachedQuote,
  type QuoteCache,
} from "../src/lib/quote-cache.ts";

const BASE = {
  format: "giclee" as const,
  size: "30x40" as const,
  frame: null,
  destinationCountryCode: "BG",
};

type FakeCache = QuoteCache & { entries: Map<string, string> };

function fakeCache(behaviour?: "throw"): FakeCache {
  const entries = new Map<string, string>();
  const cache: FakeCache = {
    entries,
    async match(request) {
      if (behaviour === "throw") throw new Error("cache down");
      const body = entries.get(request.url);
      return body === undefined
        ? undefined
        : new Response(body, { headers: { "content-type": "application/json" } });
    },
    async put(request, response) {
      if (behaviour === "throw") throw new Error("cache down");
      entries.set(request.url, await response.text());
    },
  };
  return cache;
}

test("no Cache API in the runtime means no cache, not an error", async () => {
  const caches = (globalThis as { caches?: unknown }).caches;
  try {
    delete (globalThis as { caches?: unknown }).caches;
    assert.equal(defaultQuoteCache(), null);
    assert.equal(await readCachedQuote(BASE), null);
    await writeCachedQuote(BASE, { merchandiseEur: 12, shippingEur: 4 });
  } finally {
    if (caches !== undefined) (globalThis as { caches?: unknown }).caches = caches;
  }
});

test("a Cache API with no default cache is treated as no cache", async () => {
  const caches = (globalThis as { caches?: unknown }).caches;
  try {
    (globalThis as { caches?: unknown }).caches = {};
    assert.equal(defaultQuoteCache(), null);
    assert.equal(await readCachedQuote(BASE), null);
    await writeCachedQuote(BASE, { merchandiseEur: 12, shippingEur: 4 });
  } finally {
    if (caches === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = caches;
  }
});

test("a repeated identical quote is served from cache without a Prodigi call", async () => {
  const cache = fakeCache();
  assert.equal(await readCachedQuote(BASE, cache), null);
  const quote: CachedQuote = { merchandiseEur: 13.48, shippingEur: 4.5 };
  await writeCachedQuote(BASE, quote, cache);
  assert.deepEqual(await readCachedQuote(BASE, cache), quote);
  assert.equal(cache.entries.size, 1);
});

test("the cache key separates country, size and frame", () => {
  const key = quoteCacheKey(BASE);
  assert.notEqual(key, quoteCacheKey({ ...BASE, destinationCountryCode: "US" }));
  assert.notEqual(key, quoteCacheKey({ ...BASE, size: "50x70" }));
  assert.notEqual(
    key,
    quoteCacheKey({ ...BASE, format: "framed", frame: "black" }),
  );
  assert.notEqual(
    quoteCacheKey({ ...BASE, format: "framed", frame: "black" }),
    quoteCacheKey({ ...BASE, format: "framed", frame: "white" }),
  );
  assert.equal(key, quoteCacheKey({ ...BASE }));
});

test("the cache key is stable regardless of attribute order", () => {
  const a = quoteCacheKey({ ...BASE, format: "canvas" });
  const b = quoteCacheKey({ ...BASE, format: "canvas" });
  assert.equal(a, b);
});

test("a corrupt or non-numeric cache entry is a miss, not a served price", async () => {
  for (const stored of [
    "{}",
    '{"merchandiseEur":"13.48","shippingEur":4}',
    '{"merchandiseEur":null,"shippingEur":4}',
    // A JSON body can carry values that are numbers but not real prices.
    '{"merchandiseEur":1e999,"shippingEur":4}',
    "null",
    "not json",
    "[1,2,3]",
  ]) {
    const cache = fakeCache();
    cache.entries.set(quoteCacheKey(BASE), stored);
    assert.equal(await readCachedQuote(BASE, cache), null, stored);
  }
});

test("a throwing cache degrades to a live quote", async () => {
  const cache = fakeCache("throw");
  assert.equal(await readCachedQuote(BASE, cache), null);
  await writeCachedQuote(BASE, { merchandiseEur: 12, shippingEur: 4 }, cache);
});

test("stored entries carry the TTL", async () => {
  const cache = fakeCache();
  const putHeaders: string[] = [];
  const spy: QuoteCache = {
    match: cache.match,
    async put(request, response) {
      putHeaders.push(response.headers.get("cache-control") ?? "");
      await cache.put(request, response);
    },
  };
  await writeCachedQuote(BASE, { merchandiseEur: 12, shippingEur: 4 }, spy);
  assert.equal(putHeaders[0], `public, max-age=${QUOTE_CACHE_TTL_SECONDS}`);
  assert.equal(QUOTE_CACHE_TTL_SECONDS, 1800);
});

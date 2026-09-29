import assert from "node:assert/strict";
import test from "node:test";
import { PRODIGI_SHIPPING_METHOD } from "../src/lib/prodigi-config.ts";
import {
  merchandiseFromUnitCost,
  PRODIGI_MARGIN,
} from "../src/lib/pricing.ts";
import {
  PRODIGI_LIVE_API_BASE,
  PRODIGI_SANDBOX_API_BASE,
  isProdigiUnconfigured,
  prodigiApiBase,
  prodigiApiKey,
  prodigiOrdersUrl,
  prodigiQuotesUrl,
} from "../src/lib/prodigi-config.ts";
import { quotePhysical } from "../src/lib/prodigi-quote.ts";

test("merchandiseFromUnitCost applies PRODIGI_MARGIN and rounds to cents", () => {
  assert.equal(PRODIGI_MARGIN, 1.2);
  assert.equal(merchandiseFromUnitCost(10), 12);
  assert.equal(merchandiseFromUnitCost(12.5), 15);
  assert.equal(merchandiseFromUnitCost(11.23), 13.48);
});

test("prodigiApiBase requires an explicit allowed host", () => {
  const prev = process.env.PRODIGI_API_BASE;
  try {
    delete process.env.PRODIGI_API_BASE;
    assert.throws(() => prodigiApiBase({}), /PRODIGI_API_BASE must be/);
    process.env.PRODIGI_API_BASE = "https://evil.example";
    assert.throws(() => prodigiApiBase({}), /PRODIGI_API_BASE must be/);
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
    assert.equal(prodigiApiBase({}), PRODIGI_SANDBOX_API_BASE);
    assert.equal(
      prodigiQuotesUrl({}),
      `${PRODIGI_SANDBOX_API_BASE}/v4.0/quotes`,
    );
    assert.equal(
      prodigiOrdersUrl({ PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE }),
      `${PRODIGI_LIVE_API_BASE}/v4.0/orders`,
    );
  } finally {
    if (prev === undefined) delete process.env.PRODIGI_API_BASE;
    else process.env.PRODIGI_API_BASE = prev;
  }
});

test("prodigiApiKey pairs to the explicit base (no key sniffing for host)", () => {
  const prevBase = process.env.PRODIGI_API_BASE;
  const prevSandbox = process.env.PRODIGI_SANDBOX_API_KEY;
  const prevLive = process.env.PRODIGI_API_KEY;
  try {
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    process.env.PRODIGI_API_KEY = "live-key";
    assert.equal(prodigiApiKey({}), "sandbox-key");

    process.env.PRODIGI_API_BASE = PRODIGI_LIVE_API_BASE;
    assert.equal(prodigiApiKey({}), "live-key");

    delete process.env.PRODIGI_API_KEY;
    assert.throws(() => prodigiApiKey({}), /PRODIGI_API_KEY is not set/);
  } finally {
    if (prevBase === undefined) delete process.env.PRODIGI_API_BASE;
    else process.env.PRODIGI_API_BASE = prevBase;
    if (prevSandbox === undefined) delete process.env.PRODIGI_SANDBOX_API_KEY;
    else process.env.PRODIGI_SANDBOX_API_KEY = prevSandbox;
    if (prevLive === undefined) delete process.env.PRODIGI_API_KEY;
    else process.env.PRODIGI_API_KEY = prevLive;
  }
});

test("quotePhysical margins unitCost and passes shipping through", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody: unknown;

  globalThis.fetch = (async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body));
    assert.equal(
      (init?.headers as Record<string, string>)?.["X-API-Key"],
      "test-sandbox-key",
    );
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "12.50", currency: "EUR" } }],
            costSummary: {
              shipping: { amount: "4.99", currency: "EUR" },
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "test-sandbox-key";
  delete process.env.PRODIGI_API_KEY;

  try {
    const quote = await quotePhysical({
      format: "giclee",
      size: "30x40",
    });
    assert.equal(seenUrl, "https://api.sandbox.prodigi.com/v4.0/quotes");
    assert.deepEqual(seenBody, {
      shippingMethod: PRODIGI_SHIPPING_METHOD,
      destinationCountryCode: "BG",
      currencyCode: "EUR",
      items: [
        {
          sku: "GLOBAL-FAP-12X16",
          copies: 1,
          attributes: {},
          assets: [{ printArea: "default" }],
        },
      ],
    });
    assert.equal(quote.sku, "GLOBAL-FAP-12X16");
    assert.equal(quote.unitCostEur, 12.5);
    assert.equal(quote.shippingEur, 4.99);
    assert.equal(quote.merchandiseEur, 15);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("quotePhysical framed includes color attribute and destination override", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: { destinationCountryCode?: string; items?: unknown[] };

  globalThis.fetch = (async (_input, init) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "20.00" } }],
            costSummary: { shipping: { amount: "6.00" } },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";
  try {
    const quote = await quotePhysical({
      format: "framed",
      size: "50x70",
      frame: "brown",
      destinationCountryCode: "BG",
    });
    assert.equal(seenBody.destinationCountryCode, "BG");
    assert.deepEqual(seenBody.items?.[0], {
      sku: "GLOBAL-CFPM-20X28",
      copies: 1,
      attributes: { color: "brown" },
      assets: [{ printArea: "default" }],
    });
    assert.equal(quote.merchandiseEur, 24);
    assert.equal(quote.shippingEur, 6);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("quotePhysical uses live host when PRODIGI_API_BASE is live", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";

  globalThis.fetch = (async (input) => {
    seenUrl = String(input);
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "10.00" } }],
            costSummary: { shipping: { amount: "3.00" } },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  process.env.PRODIGI_API_BASE = PRODIGI_LIVE_API_BASE;
  process.env.PRODIGI_API_KEY = "live-key";
  delete process.env.PRODIGI_SANDBOX_API_KEY;

  try {
    await quotePhysical({ format: "canvas", size: "30x40" });
    assert.equal(seenUrl, "https://api.prodigi.com/v4.0/quotes");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_API_KEY;
  }
});

test("quotePhysical throws on non-OK HTTP and missing quote fields", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";

  try {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /Prodigi quote HTTP 500/,
    );

    // A 200 that is not JSON is a distinct failure, not a parse crash and not
    // a silent "no quote": a proxy error page lands here in practice.
    globalThis.fetch = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /invalid JSON/,
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ quotes: [] }), {
        status: 200,
      })) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /missing quotes\[0\]/,
    );

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          quotes: [{ items: [{}], costSummary: {} }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /missing unitCost/,
    );

    // An amount with more than six integer digits is rejected, the same answer
    // the stored-record path gives. This copy of the grammar used to accept it.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          quotes: [
            {
              items: [{ unitCost: { amount: "1234567.89" } }],
              costSummary: { shipping: { amount: "6.00" } },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /missing unitCost/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("a bad Prodigi host reads as unconfigured, not as a bad gateway", async () => {
  // isProdigiUnconfigured only matched "<NAME>_API_KEY is not set", so a
  // misconfigured PRODIGI_API_BASE fell through to 502 — the one status that
  // means "something upstream is unhealthy". A human would go check Prodigi's
  // status page for a deploy problem of ours. Both quote and checkout use this
  // predicate, so it has to cover every way to be unconfigured.
  assert.equal(
    isProdigiUnconfigured("PRODIGI_API_KEY is not set"),
    true,
  );
  assert.equal(
    isProdigiUnconfigured(
      "PRODIGI_API_BASE must be https://api.sandbox.prodigi.com or https://api.prodigi.com",
    ),
    true,
  );
  // A genuine upstream failure must NOT be reported as our misconfiguration.
  for (const message of [
    "Prodigi quote HTTP 502",
    "Prodigi quote returned invalid JSON",
    "Prodigi quote missing quotes[0]",
  ]) {
    assert.equal(isProdigiUnconfigured(message), false, message);
  }
});

test("quotePhysical surfaces a misconfigured host before any network call", async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    process.env.PRODIGI_API_BASE = "https://evil.example";
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      // The route turns this into 503 via isProdigiUnconfigured.
      (e: Error) => isProdigiUnconfigured(e.message),
    );
    assert.equal(called, 0, "an unknown host is never contacted");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("every config-failure message is recognised as ours, not as a 502", async () => {
  // The standing rule (DEVELOPMENT.md §7): a misconfiguration of our deploy
  // must never surface as an upstream 502/500. This walks every message the
  // Prodigi config layer can throw through the real getters and asserts the
  // predicate claims each one, so a newly added config error cannot silently
  // fall back to "bad gateway" and point an operator at Prodigi's status page
  // for a problem of ours.
  const cases: Array<{ env: Record<string, unknown>; what: string }> = [
    { env: {}, what: "PRODIGI_API_BASE unset" },
    { env: { PRODIGI_API_BASE: "" }, what: "PRODIGI_API_BASE empty" },
    { env: { PRODIGI_API_BASE: "   " }, what: "PRODIGI_API_BASE whitespace" },
    {
      env: { PRODIGI_API_BASE: "https://api.attacker.example" },
      what: "PRODIGI_API_BASE not allowlisted",
    },
    {
      env: { PRODIGI_API_BASE: "https://api.prodigi.com.evil.example" },
      what: "PRODIGI_API_BASE lookalike host",
    },
    {
      env: { PRODIGI_API_BASE: "http://api.sandbox.prodigi.com" },
      what: "PRODIGI_API_BASE wrong scheme",
    },
    {
      env: { PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE },
      what: "sandbox host, sandbox key unset",
    },
    {
      env: {
        PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
        PRODIGI_SANDBOX_API_KEY: "",
      },
      what: "sandbox key empty",
    },
    {
      env: {
        PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
        PRODIGI_SANDBOX_API_KEY: "   ",
      },
      what: "sandbox key whitespace",
    },
    {
      env: { PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE },
      what: "live host, live key unset",
    },
    {
      env: { PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE, PRODIGI_API_KEY: "" },
      what: "live key empty",
    },
  ];

  const messages: string[] = [];
  for (const { env, what } of cases) {
    // Which getter *should* throw depends on the case: with an allowlisted
    // base but no key, prodigiApiBase legitimately succeeds and only the key
    // reader fails. Asserting every getter throws would be asserting the code
    // is broken.
    // The URL builders depend only on the base; only prodigiApiKey depends on
    // the credential. Asking a URL builder to fail on a missing key would be
    // asserting a bug that does not exist.
    const baseOk = env.PRODIGI_API_BASE === PRODIGI_SANDBOX_API_BASE ||
      env.PRODIGI_API_BASE === PRODIGI_LIVE_API_BASE;
    const getters = baseOk
      ? [prodigiApiKey]
      : [prodigiApiBase, prodigiQuotesUrl, prodigiOrdersUrl];
    for (const getter of getters) {
      try {
        getter(env);
        assert.fail(`${what}: ${getter.name} unexpectedly succeeded`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        messages.push(message);
        assert.equal(
          isProdigiUnconfigured(message),
          true,
          `${what} via ${getter.name} reported as an upstream failure: ${message}`,
        );
      }
    }
  }
  assert.ok(messages.length >= cases.length);

  // And the converse: a real upstream failure must NOT be claimed as ours, or
  // we would hide a Prodigi outage behind "unconfigured, just redeploy".
  for (const message of [
    "Prodigi quote HTTP 500",
    "Prodigi quote HTTP 429",
    "Prodigi order HTTP 401",
    "Prodigi quote returned invalid JSON",
    "Prodigi quote missing quotes[0]",
    "Prodigi quote missing unitCost",
    "fetch failed",
  ]) {
    assert.equal(isProdigiUnconfigured(message), false, message);
  }
});

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
  readProdigiConfig,
} from "../src/lib/prodigi-config.ts";
import { quotePhysical, type PhysicalQuote } from "../src/lib/prodigi-quote.ts";

test("merchandiseFromUnitCost applies PRODIGI_MARGIN and rounds to cents", () => {
  assert.equal(PRODIGI_MARGIN, 1.2);
  assert.equal(merchandiseFromUnitCost(10), 12);
  assert.equal(merchandiseFromUnitCost(12.5), 15);
  assert.equal(merchandiseFromUnitCost(11.23), 13.48);
});

test("readProdigiConfig requires an explicit allowed host", () => {
  const prev = process.env.PRODIGI_API_BASE;
  try {
    delete process.env.PRODIGI_API_BASE;
    assert.equal(readProdigiConfig({}).ok, false);
    assert.match(readProdigiConfig({}).message, /PRODIGI_API_BASE must be/);
    process.env.PRODIGI_API_BASE = "https://evil.example";
    assert.equal(readProdigiConfig({}).ok, false);
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
    assert.deepEqual(
      readProdigiConfig({ PRODIGI_SANDBOX_API_KEY: "k" }),
      { ok: true, base: PRODIGI_SANDBOX_API_BASE, key: "k" },
    );
  } finally {
    if (prev === undefined) delete process.env.PRODIGI_API_BASE;
    else process.env.PRODIGI_API_BASE = prev;
  }
});

test("readProdigiConfig pairs to the explicit base (no key sniffing for host)", () => {
  const prevBase = process.env.PRODIGI_API_BASE;
  const prevSandbox = process.env.PRODIGI_SANDBOX_API_KEY;
  const prevLive = process.env.PRODIGI_API_KEY;
  try {
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    process.env.PRODIGI_API_KEY = "live-key";
    assert.equal(readProdigiConfig({}).key, "sandbox-key");

    process.env.PRODIGI_API_BASE = PRODIGI_LIVE_API_BASE;
    assert.equal(readProdigiConfig({}).key, "live-key");

    delete process.env.PRODIGI_API_KEY;
    assert.equal(readProdigiConfig({}).ok, false);
    assert.match(readProdigiConfig({}).message, /PRODIGI_API_KEY is not set/);
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
    const result = await quotePhysical({
      format: "giclee",
      size: "30x40",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const quote: PhysicalQuote = result.value;
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
    const result = await quotePhysical({
      format: "framed",
      size: "50x70",
      frame: "brown",
      destinationCountryCode: "BG",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(seenBody.destinationCountryCode, "BG");
    assert.deepEqual(seenBody.items?.[0], {
      sku: "GLOBAL-CFPM-20X28",
      copies: 1,
      attributes: { color: "brown" },
      assets: [{ printArea: "default" }],
    });
    assert.equal(result.value.merchandiseEur, 24);
    assert.equal(result.value.shippingEur, 6);
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
    const result = await quotePhysical({ format: "canvas", size: "30x40" });
    assert.equal(result.ok, true);
    assert.equal(seenUrl, "https://api.prodigi.com/v4.0/quotes");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_API_KEY;
  }
});

test("quotePhysical returns a failure on non-OK HTTP and missing quote fields", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";

  try {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    let result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote HTTP 500");
    assert.equal(result.ok || result.kind, "server");
    assert.equal(result.ok || result.reason, "prodigi-unavailable");

    // A 200 that is not JSON is a distinct failure, not a parse crash and not
    // a silent "no quote": a proxy error page lands here in practice.
    globalThis.fetch = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote returned invalid JSON");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ quotes: [] }), {
        status: 200,
      })) as typeof fetch;
    result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote missing quotes[0]");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          quotes: [{ items: [{}], costSummary: {} }],
        }),
        { status: 200 },
      )) as typeof fetch;
    result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote missing unitCost");

    // A unitCost with no shipping amount is the other missing half.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          quotes: [{ items: [{ unitCost: { amount: "10.00" } }], costSummary: {} }],
        }),
        { status: 200 },
      )) as typeof fetch;
    result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote missing shipping");

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
    result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.message, "Prodigi quote missing unitCost");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("an Error thrown by fetch keeps its message; a non-Error gets a fixed label", async () => {
  // Both arms of the catch's message ternary. Only the non-Error arm was
  // exercised (routes.test.mts throws a string), so the Error arm was never
  // run by any test, and whether V8's merged report flagged it depended on how
  // the per-file coverage happened to merge: branches read 99.92% on one run
  // and 99.84% on the next with identical sources.
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const failed = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(failed.ok === false && failed.reason, "prodigi-unavailable");
    assert.equal(failed.ok === false && failed.message, "fetch failed");

    globalThis.fetch = (async () => {
      throw "socket exploded";
    }) as typeof fetch;
    const odd = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(odd.ok === false && odd.message, "network-error");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("a bad Prodigi host reads as unconfigured, not as a bad gateway", async () => {
  // A misconfigured PRODIGI_API_BASE is our fault, not Prodigi's: the quote
  // result carries kind "unconfigured" and reason "prodigi-unconfigured", so the
  // route answers 503. A genuine upstream failure keeps kind "server"/"client".
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    process.env.PRODIGI_API_BASE = "https://evil.example";
    const result = await quotePhysical({ format: "canvas", size: "70x100" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "unconfigured");
    assert.equal(result.ok === false && result.reason, "prodigi-unconfigured");
    assert.equal(called, 0, "an unknown host is never contacted");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
});

test("every config-failure way is read as unconfigured, and upstream is not", () => {
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
    const result = readProdigiConfig(env);
    assert.equal(result.ok, false, what);
    assert.equal(result.kind, "unconfigured", what);
    assert.equal(result.reason, "prodigi-unconfigured", what);
    messages.push(result.message);
  }
  assert.ok(messages.length >= cases.length);
});

/**
 * #130: a Prodigi error body names the field it objected to, and we were
 * throwing that body away. `Prodigi quote HTTP 400` alone cannot tell an
 * operator whether Prodigi is unwell or we sent a request it will never
 * accept — which is the difference between checking Prodigi's status page and
 * checking our own SKU map.
 */
async function quoteFailureFrom(status: number, raw: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(raw, { status })) as typeof fetch;
  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";
  try {
    const result = await quotePhysical({ format: "canvas", size: "30x40" });
    assert.equal(result.ok, false, `expected a failure for HTTP ${status}`);
    return result.ok ? "" : result.message;
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_API_BASE;
  }
}

test("a failed quote carries Prodigi's own detail, not just our status", async () => {
  const detail = await quoteFailureFrom(
    400,
    JSON.stringify({ detail: "SKU GLOBAL-CAN-12X16 is not available" }),
  );
  assert.equal(detail, "Prodigi quote HTTP 400: SKU GLOBAL-CAN-12X16 is not available");
});

test("Prodigi's detail is read from message and error too", async () => {
  assert.equal(
    await quoteFailureFrom(400, JSON.stringify({ message: "bad request" })),
    "Prodigi quote HTTP 400: bad request",
  );
  assert.equal(
    await quoteFailureFrom(401, JSON.stringify({ error: "invalid api key" })),
    "Prodigi quote HTTP 401: invalid api key",
  );
  assert.equal(
    await quoteFailureFrom(400, JSON.stringify("plain string body")),
    "Prodigi quote HTTP 400: plain string body",
  );
});

test("an unreadable error body leaves the message exactly as it was", async () => {
  for (const raw of [
    "<html>502</html>",
    "{}",
    JSON.stringify({ detail: "" }),
    // Whitespace-only collapses to nothing, so it contributes no suffix.
    JSON.stringify({ detail: "   \n  " }),

    "",
    // A JSON scalar is a body we understood and have nothing to say about,
    // which is different from a body we could not read at all.
    "null",
    "42",
  ]) {
    assert.equal(
      await quoteFailureFrom(500, raw),
      "Prodigi quote HTTP 500",
      JSON.stringify(raw),
    );
  }
});

test("an upstream detail is whitespace-collapsed before it is shown", async () => {
  // A detail spanning several lines would otherwise break the log line it is
  // appended to, and a log that needs reformatting to read is a log nobody
  // reads.
  assert.equal(
    await quoteFailureFrom(400, JSON.stringify({ detail: "  SKU\n  not\n found  " })),
    "Prodigi quote HTTP 400: SKU not found",
  );
});

test("an unbounded upstream detail is truncated", async () => {
  const message = await quoteFailureFrom(
    400,
    JSON.stringify({ detail: "x".repeat(5000) }),
  );
  assert.ok(message.length < 260, `message was ${message.length} chars`);
  assert.ok(message.endsWith("…"));
});

test("an upstream detail echoing a config message is classified by status, not text", async () => {
  // #118: the failure kind comes from the HTTP status, never from matching the
  // message. A 400 whose detail happens to quote a config string is a
  // validation error, not an unconfigured deployment.
  const result = await (async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ detail: "PRODIGI_SANDBOX_API_KEY is not set" }),
        { status: 400 },
      )) as typeof fetch;
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";
    try {
      return await quotePhysical({ format: "canvas", size: "30x40" });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.PRODIGI_SANDBOX_API_KEY;
      delete process.env.PRODIGI_API_BASE;
    }
  })();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "client");
  assert.equal(result.ok === false && result.reason, "prodigi-validation-error");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  merchandiseFromUnitCost,
  PRODIGI_MARGIN,
} from "../src/lib/pricing.ts";
import { quotePhysical } from "../src/lib/prodigi-quote.ts";

test("merchandiseFromUnitCost applies PRODIGI_MARGIN and rounds to cents", () => {
  assert.equal(PRODIGI_MARGIN, 1.2);
  assert.equal(merchandiseFromUnitCost(10), 12);
  assert.equal(merchandiseFromUnitCost(12.5), 15);
  assert.equal(merchandiseFromUnitCost(11.23), 13.48);
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

  process.env.PRODIGI_SANDBOX_API_KEY = "test-sandbox-key";
  delete process.env.PRODIGI_API_KEY;

  try {
    const quote = await quotePhysical({
      format: "giclee",
      size: "30x40",
    });
    assert.equal(seenUrl, "https://api.sandbox.prodigi.com/v4.0/quotes");
    assert.deepEqual(seenBody, {
      shippingMethod: "Budget",
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
  }
});

test("quotePhysical throws on non-OK HTTP and missing quote fields", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox";

  try {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => quotePhysical({ format: "canvas", size: "70x100" }),
      /Prodigi quote HTTP 500/,
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
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
  }
});

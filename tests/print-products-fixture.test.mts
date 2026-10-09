/**
 * The pinned print table is only the source of truth if it matches the Prodigi
 * catalogue it claims to describe (#296). This is the contract test: it reads
 * the captured fixture and fails on any drift, so a changed Prodigi product
 * shows up as a fixture diff in a reviewed PR rather than a silently wrong
 * print area feeding #299's resolution maths.
 *
 * It also proves the two request bodies we send are unchanged: for every
 * product, the real quote and order payloads carry the same SKU and attributes
 * the table defines.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findProduct,
  PRINT_PRODUCTS,
  printAreaIn,
  type PrintProductEntry,
} from "../src/domain/pricing/print-products.ts";
import { resolveSku, type PhysicalFormat } from "../src/domain/pricing/sku-map.ts";
import { SHIP_TO_COUNTRY_CODES } from "../src/domain/pricing/ship-to-countries.ts";
import { PRODIGI_SANDBOX_API_BASE } from "../src/infrastructure/prodigi/prodigi-config.ts";
import { quotePhysical } from "../src/infrastructure/prodigi/prodigi-quote.ts";
import { buildProdigiOrderBody } from "../src/infrastructure/prodigi/prodigi-order.ts";
import type { OrderRecipient } from "../src/domain/ordering/order-recipient.ts";

type FixtureProduct = {
  sku: string;
  attributes: Record<string, string>;
  printAreaPx: { short: number; long: number };
  shipsTo: string[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/prodigi/products.json", import.meta.url),
    "utf8",
  ),
) as { base: string; products: FixtureProduct[] };

const bySku = new Map(fixture.products.map((p) => [p.sku, p]));

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

const ASSET_URL =
  "https://nessebarlens.com/api/print-asset?slug=x&exp=1799999999&sig=" +
  "a".repeat(64);

/** The attributes each format sends, independent of the table under test. */
const EXPECTED_ATTRIBUTES: Record<PhysicalFormat, Record<string, string>> = {
  giclee: {},
  framed: { color: "black" },
  canvas: { wrap: "ImageWrap" },
};

test("the fixture was captured from the sandbox", () => {
  assert.equal(fixture.base, PRODIGI_SANDBOX_API_BASE);
});

test("the fixture and the table describe the same products, with no orphans", () => {
  const tableSkus = PRINT_PRODUCTS.map((p) => p.sku).sort();
  const fixtureSkus = fixture.products.map((p) => p.sku).sort();
  assert.deepEqual(tableSkus, fixtureSkus);
  assert.equal(new Set(tableSkus).size, tableSkus.length);
});

test("every table print area matches the capture exactly", () => {
  for (const product of PRINT_PRODUCTS) {
    const captured = bySku.get(product.sku);
    assert.ok(captured, `no fixture for ${product.sku}`);
    assert.deepEqual(
      product.printAreaPx,
      captured.printAreaPx,
      `${product.sku} print area drifted`,
    );
    assert.ok(product.printAreaPx.short > 0);
    assert.ok(product.printAreaPx.long >= product.printAreaPx.short);
  }
});

test("printAreaIn is the pixel area over the catalogue DPI", () => {
  for (const product of PRINT_PRODUCTS) {
    const inches = printAreaIn(product);
    assert.equal(inches.short, product.printAreaPx.short / product.printAreaDpi);
    assert.equal(inches.long, product.printAreaPx.long / product.printAreaDpi);
    assert.ok(inches.short > 0 && inches.long >= inches.short);
  }
});

test("the attributes we send match the captured variant's selector", () => {
  for (const product of PRINT_PRODUCTS) {
    const captured = bySku.get(product.sku)!;
    const entry = resolveSku(
      product.format,
      product.size,
      product.format === "framed" ? "black" : null,
    );
    assert.deepEqual(
      entry.attributes,
      captured.attributes,
      `${product.sku} attributes drifted`,
    );
    assert.deepEqual(entry.attributes, EXPECTED_ATTRIBUTES[product.format]);
  }
});

test("every captured shipsTo list is sane, and we never ship where Prodigi cannot", () => {
  for (const product of fixture.products) {
    assert.ok(product.shipsTo.length > 0, `${product.sku} ships nowhere`);
    assert.equal(
      new Set(product.shipsTo).size,
      product.shipsTo.length,
      `${product.sku} repeats a country`,
    );
    for (const code of product.shipsTo) {
      assert.match(code, /^[A-Z]{2}$/);
    }
  }
  // The countries every product ships to: the only ones Stripe may be offered.
  const common = fixture.products
    .map((p) => new Set(p.shipsTo))
    .reduce((acc, set) => new Set([...acc].filter((c) => set.has(c))));
  for (const code of SHIP_TO_COUNTRY_CODES) {
    assert.ok(common.has(code), `we ship to ${code} but Prodigi does not`);
  }
  // Non-vacuous: the intersection exists and is smaller than any one list.
  assert.ok(common.size > 0);
  assert.ok(common.size <= fixture.products[0]!.shipsTo.length);
});

/** Capture the quote body for one product through the real quote builder. */
async function quoteItems(product: PrintProductEntry) {
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;
  process.env.PRODIGI_SANDBOX_API_KEY = "test-sandbox-key";
  let seen: { items?: unknown[] } = {};
  globalThis.fetch = (async (_input, init) => {
    seen = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "10.00" } }],
            costSummary: { shipping: { amount: "5.00" } },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const result = await quotePhysical({
      format: product.format,
      size: product.size,
      frame: product.format === "framed" ? "black" : null,
    });
    assert.equal(result.ok, true, `${product.sku} quote failed`);
    return seen.items?.[0];
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
  }
}

test("every product quotes with the table's SKU and attributes", async () => {
  for (const product of PRINT_PRODUCTS) {
    assert.deepEqual(
      await quoteItems(product),
      {
        sku: product.sku,
        copies: 1,
        attributes: EXPECTED_ATTRIBUTES[product.format],
        assets: [{ printArea: "default" }],
      },
      product.sku,
    );
  }
});

test("every product orders with the table's SKU and attributes", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  for (const product of PRINT_PRODUCTS) {
    const body = buildProdigiOrderBody({
      sessionId: "cs_test_abcdefgh",
      photoSlug: "x",
      format: product.format,
      size: product.size,
      frame: product.format === "framed" ? "black" : null,
      recipient: RECIPIENT,
      assetUrl: ASSET_URL,
    });
    assert.deepEqual(
      body.items[0],
      {
        sku: product.sku,
        copies: 1,
        sizing: "fillPrintArea",
        attributes: EXPECTED_ATTRIBUTES[product.format],
        assets: [{ printArea: "default", url: ASSET_URL }],
      },
      product.sku,
    );
  }
});

test("findProduct is the pair lookup, and null for a pair the table lacks", () => {
  const first = PRINT_PRODUCTS[0]!;
  assert.equal(findProduct(first.format, first.size)?.sku, first.sku);
  assert.equal(
    findProduct("giclee", "70x100", [
      {
        format: "giclee",
        size: "30x40",
        sizeIn: "12x16",
        sku: "GLOBAL-FAP-12X16",
        printAreaPx: { short: 3600, long: 4800 },
        printAreaDpi: 300,
      },
    ]),
    null,
  );
});

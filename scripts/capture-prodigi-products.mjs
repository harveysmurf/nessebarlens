#!/usr/bin/env node
/**
 * Capture the pinned Prodigi products as a contract fixture (#296).
 *
 * The print areas #291's resolution maths needs — the mount window for framed
 * prints and the area including the wrap for canvas — live only in Prodigi's
 * product catalogue. This script reads them from the sandbox and writes
 * tests/fixtures/prodigi/products.json, which the pure PRINT_PRODUCTS table is
 * contract-tested against. A changed Prodigi catalogue then shows up as a
 * fixture diff in a reviewed PR instead of silently skewing the maths.
 *
 * For each SKU it records the print area of the variant we order (frame color
 * black, canvas wrap ImageWrap, no attributes otherwise), the attributes the
 * order body sends, and the variant's shipsTo list. It takes a SKU list, so
 * #303 can capture new size candidates with the same script.
 *
 * Sandbox only: it refuses any base that is not the sandbox host, and it
 * refuses a key that is not present. It never contacts the live host.
 *
 * Usage: PRODIGI_SANDBOX_API_KEY=... node scripts/capture-prodigi-products.mjs [SKU ...]
 * With no SKUs it captures the nine pinned products.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PRODIGI_SANDBOX_API_BASE = "https://api.sandbox.prodigi.com";

const FIXTURE_DIR = path.join(
  import.meta.dirname,
  "..",
  "tests",
  "fixtures",
  "prodigi",
);
const FIXTURE_FILE = path.join(FIXTURE_DIR, "products.json");

/** The nine products we sell today, in catalog order (format-major). */
export const DEFAULT_SKUS = [
  "GLOBAL-FAP-12X16",
  "GLOBAL-FAP-20X28",
  "GLOBAL-FAP-28X40",
  "GLOBAL-CFPM-12X16",
  "GLOBAL-CFPM-20X28",
  "GLOBAL-CFPM-28X40",
  "GLOBAL-CAN-12X16",
  "GLOBAL-CAN-20X28",
  "GLOBAL-CAN-28X40",
];

/**
 * The attributes our order body sends for a SKU's format. This is the selector
 * for which Prodigi variant's print area and shipsTo we record: framed prints
 * ship with a black frame, canvas with ImageWrap, giclée with nothing.
 */
export function selectorFor(sku) {
  if (sku.startsWith("GLOBAL-CFPM-")) return { color: "black" };
  if (sku.startsWith("GLOBAL-CAN-")) return { wrap: "ImageWrap" };
  return {};
}

function variantMatches(variant, attributes) {
  return Object.entries(attributes).every(
    ([key, value]) => variant.attributes?.[key] === value,
  );
}

/**
 * The default print area of one SKU. The `{ short, long }` pair is the ordering
 * view the resolution maths uses; `width` and `height` keep the raw orientation
 * (#307), because every pinned print area is portrait and the print asset must
 * be turned to match. A landscape value here would be a captured-catalogue
 * change worth a failing contract test, not a silent flip.
 */
export function printAreaOf(product, attributes) {
  const variant = product.variants?.find((v) => variantMatches(v, attributes));
  if (!variant) {
    throw new Error(`no variant matches ${JSON.stringify(attributes)}`);
  }
  const area = variant.printAreaSizes?.default;
  if (!area) {
    throw new Error("variant has no printAreaSizes.default");
  }
  const { horizontalResolution, verticalResolution } = area;
  return {
    width: horizontalResolution,
    height: verticalResolution,
    short: Math.min(horizontalResolution, verticalResolution),
    long: Math.max(horizontalResolution, verticalResolution),
  };
}

export function shipsToOf(product, attributes) {
  const variant = product.variants?.find((v) => variantMatches(v, attributes));
  if (!variant || !Array.isArray(variant.shipsTo)) {
    throw new Error("variant has no shipsTo list");
  }
  return [...variant.shipsTo].sort();
}

/** Read one SKU from the sandbox, as the fixture record the table is tested against. */
export async function captureSku({ base, key, sku, fetchImpl = fetch }) {
  const attributes = selectorFor(sku);
  const res = await fetchImpl(`${base}/v4.0/products/${sku}`, {
    headers: { "X-API-Key": key },
  });
  if (!res.ok) {
    throw new Error(`GET /v4.0/products/${sku} → HTTP ${res.status}`);
  }
  const body = await res.json();
  const product = body.product;
  if (!product) throw new Error(`response for ${sku} has no product`);
  return {
    sku,
    attributes,
    printAreaPx: printAreaOf(product, attributes),
    shipsTo: shipsToOf(product, attributes),
  };
}

/** The fixture document, deterministic: products in the order asked for. */
export async function captureProducts({ base, key, skus, fetchImpl = fetch }) {
  const products = [];
  for (const sku of skus) {
    products.push(await captureSku({ base, key, sku, fetchImpl }));
  }
  return { base, products };
}

/** Strip trailing slashes without re-spelling url-patterns.ts's regex. */
function trimTrailingSlashes(value) {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Refuse anything that is not the sandbox host, so a live key cannot be used. */
export function assertSandboxBase(value) {
  const base = trimTrailingSlashes(value ?? PRODIGI_SANDBOX_API_BASE);
  if (base !== PRODIGI_SANDBOX_API_BASE) {
    throw new Error(
      `refusing non-sandbox base ${base}; expected ${PRODIGI_SANDBOX_API_BASE}`,
    );
  }
  return base;
}

export function parseArgs(argv, env = process.env) {
  const check = argv.includes("--check");
  const named = argv.filter((arg) => !arg.startsWith("--"));
  const skus = named.length > 0 ? named : DEFAULT_SKUS;
  const base = assertSandboxBase(env.PRODIGI_API_BASE);
  const key = env.PRODIGI_SANDBOX_API_KEY;
  if (!key) throw new Error("PRODIGI_SANDBOX_API_KEY is not set");
  return { base, key, skus, check };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    console.error(`capture-prodigi: ${e.message}`);
    return 1;
  }
  const doc = await captureProducts(args);

  // --check compares against the committed fixture without writing it, so a
  // sandbox-gated CI job can assert the live catalogue still matches.
  if (args.check) {
    const existing = JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));
    if (JSON.stringify(existing.products) !== JSON.stringify(doc.products)) {
      console.error(
        "capture-prodigi: live sandbox differs from the committed fixture",
      );
      return 1;
    }
    console.log("capture-prodigi: fixture matches the live sandbox");
    return 0;
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(process.cwd(), FIXTURE_FILE)} (${doc.products.length} products)`,
  );
  return 0;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`capture-prodigi: unexpected error: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}

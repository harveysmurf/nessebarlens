#!/usr/bin/env node
/**
 * Regenerate the SHIP_TO_COUNTRIES block in
 * src/domain/pricing/ship-to-countries.ts (#296).
 *
 * The list is the intersection of the captured Prodigi variants' `shipsTo`
 * (tests/fixtures/prodigi/products.json) with Stripe Checkout's
 * `ShippingAddressCollection.AllowedCountry`, read from the installed `stripe`
 * SDK's type declaration. Names are the ICU region names for "en", which is
 * what the committed list already uses, so the diff is only ever a real change
 * in what the two providers support.
 *
 * Only the block between the BEGIN/END markers is rewritten, so the type, the
 * membership predicate and the default destination stay hand-owned.
 *
 * Usage:
 *   node scripts/generate-ship-to-countries.mjs          # write the file
 *   node scripts/generate-ship-to-countries.mjs --check  # compare, write nothing
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "prodigi", "products.json");
const TARGET = path.join(ROOT, "src", "domain", "pricing", "ship-to-countries.ts");
const STRIPE_TYPES = path.join(
  ROOT,
  "node_modules",
  "stripe",
  "esm",
  "resources",
  "Checkout",
  "Sessions.d.ts",
);

const BEGIN = "// BEGIN GENERATED (scripts/generate-ship-to-countries.mjs)";
const END = "// END GENERATED";

/** Stripe's AllowedCountry codes, read from the SDK's own type union. */
export function stripeAllowedCountries(sdkSource) {
  const match = sdkSource.match(/type AllowedCountry = ([^;]+);/);
  if (!match) throw new Error("AllowedCountry union not found in Stripe types");
  const codes = new Set();
  for (const [, code] of match[1].matchAll(/'([A-Z]{2})'/g)) {
    if (code !== "ZZ") codes.add(code);
  }
  return codes;
}

/**
 * The countries to offer: every product ships there, and Stripe accepts the
 * address. Ordered by display name, which is the order the committed list has.
 */
export function computeCountries(products, stripeCodes, displayName) {
  const common = products
    .map((product) => new Set(product.shipsTo))
    .reduce((acc, set) => new Set([...acc].filter((code) => set.has(code))));
  return [...common]
    .filter((code) => stripeCodes.has(code))
    .map((code) => ({ code, name: displayName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function renderBlock(countries) {
  const rows = countries
    .map(({ code, name }) => `  { code: ${JSON.stringify(code)}, name: ${JSON.stringify(name)} },`)
    .join("\n");
  return `export const SHIP_TO_COUNTRIES = [\n${rows}\n] as const;`;
}

/** Replace the marked block in `source` with `block`. Pure. */
export function withBlock(source, block) {
  const beginAt = source.indexOf(BEGIN);
  const endAt = source.indexOf(END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error("generated block markers not found in ship-to-countries.ts");
  }
  const before = source.slice(0, beginAt + BEGIN.length);
  const after = source.slice(endAt);
  return `${before}\n${block}\n${after}`;
}

export function generate({ fixture, sdkSource, source, displayName }) {
  const codes = stripeAllowedCountries(sdkSource);
  const countries = computeCountries(
    fixture.products,
    codes,
    displayName ?? ((code) => new Intl.DisplayNames(["en"], { type: "region" }).of(code)),
  );
  return withBlock(source, renderBlock(countries));
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const sdkSource = readFileSync(STRIPE_TYPES, "utf8");
  const source = readFileSync(TARGET, "utf8");
  const next = generate({ fixture, sdkSource, source });
  if (check) {
    if (next !== source) {
      console.error(
        "generate-ship-to-countries: src/domain/pricing/ship-to-countries.ts is stale; run `node scripts/generate-ship-to-countries.mjs`",
      );
      return 1;
    }
    console.log("generate-ship-to-countries: up to date");
    return 0;
  }
  if (next === source) {
    console.log("generate-ship-to-countries: no change");
    return 0;
  }
  writeFileSync(TARGET, next);
  console.log(`wrote ${path.relative(process.cwd(), TARGET)}`);
  return 0;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`generate-ship-to-countries: unexpected error: ${e?.message ?? e}`);
    process.exit(1);
  }
}

/**
 * The pure half of scripts/generate-ship-to-countries.mjs (#296).
 *
 * The generator rewrites a committed, customer-facing list, so the selection
 * rule — intersection of Prodigi shipsTo, filtered to Stripe's AllowedCountry,
 * ordered by display name — is tested without touching the filesystem or the
 * real fixture.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCountries,
  renderBlock,
  stripeAllowedCountries,
  withBlock,
} from "../scripts/generate-ship-to-countries.mjs";

const DISPLAY = (code: string) => code;

test("stripeAllowedCountries reads the SDK union and drops the placeholder", () => {
  const codes = stripeAllowedCountries(
    "type AllowedCountry = 'AA' | 'BB' | 'ZZ' | OtherString;",
  );
  assert.deepEqual([...codes].sort(), ["AA", "BB"]);
  assert.throws(() => stripeAllowedCountries("no union here"), /not found/);
});

test("computeCountries intersects, filters and orders by display name", () => {
  const products = [
    { shipsTo: ["US", "BG", "DE", "JP"] },
    { shipsTo: ["BG", "DE", "US"] },
    { shipsTo: ["US", "BG", "DE"] },
  ];
  const allowed = new Set(["US", "BG", "DE", "JP"]);
  const names: Record<string, string> = {
    US: "United States",
    BG: "Bulgaria",
    DE: "Germany",
  };
  assert.deepEqual(computeCountries(products, allowed, (c) => names[c]!), [
    { code: "BG", name: "Bulgaria" },
    { code: "DE", name: "Germany" },
    { code: "US", name: "United States" },
  ]);
  // A country only one product ships to is not offered.
  assert.deepEqual(
    computeCountries(products, new Set(["JP"]), DISPLAY),
    [],
  );
  // A country Prodigi ships to but Stripe does not accept is dropped.
  assert.deepEqual(
    computeCountries(products, new Set(["US"]), DISPLAY),
    [{ code: "US", name: "US" }],
  );
});

test("withBlock replaces only the marked array", () => {
  const source = [
    "before",
    "// BEGIN GENERATED (scripts/generate-ship-to-countries.mjs)",
    "export const SHIP_TO_COUNTRIES = [",
    "  { code: 'OLD', name: 'Old' },",
    "] as const;",
    "// END GENERATED",
    "after",
  ].join("\n");
  const block = renderBlock([{ code: "US", name: "United States" }]);
  const out = withBlock(source, block);
  assert.match(out, /before/);
  assert.match(out, /after/);
  assert.match(out, /\{ code: "US", name: "United States" \}/);
  assert.doesNotMatch(out, /OLD/);
  assert.throws(() => withBlock("no markers", block), /markers not found/);
});

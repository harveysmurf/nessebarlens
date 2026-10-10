/**
 * The sandbox-gated half of the print-product contract (#296).
 *
 * The fixture is only trustworthy if it can be re-derived from Prodigi. This
 * test re-captures the pinned products from the sandbox and compares, so a run
 * with PRODIGI_SANDBOX_API_KEY set fails when the live catalogue has moved on
 * from what the committed table encodes. Without a key it skips, exactly as
 * the other sandbox-gated tests do.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertSandboxBase,
  captureProducts,
  DEFAULT_SKUS,
  parseArgs,
  PRODIGI_SANDBOX_API_BASE,
} from "../scripts/capture-prodigi-products.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/prodigi/products.json", import.meta.url),
    "utf8",
  ),
) as { base: string; products: unknown[] };

test("assertSandboxBase allows the sandbox host and refuses everything else", () => {
  assert.equal(
    assertSandboxBase(undefined),
    PRODIGI_SANDBOX_API_BASE,
  );
  assert.equal(
    assertSandboxBase(`${PRODIGI_SANDBOX_API_BASE}/`),
    PRODIGI_SANDBOX_API_BASE,
  );
  for (const bad of [
    "https://api.prodigi.com",
    "http://api.sandbox.prodigi.com",
    "https://evil.example",
  ]) {
    assert.throws(() => assertSandboxBase(bad), /refusing non-sandbox/, bad);
  }
});

test("parseArgs defaults to the pinned SKUs and reads --check", () => {
  const env = { PRODIGI_SANDBOX_API_KEY: "k" };
  assert.deepEqual(parseArgs([], env).skus, DEFAULT_SKUS);
  assert.equal(parseArgs([], env).check, false);
  const check = parseArgs(["--check"], { ...env, PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE });
  assert.equal(check.check, true);
  assert.deepEqual(check.skus, DEFAULT_SKUS);
  assert.deepEqual(parseArgs(["GLOBAL-FAP-12X16"], env).skus, ["GLOBAL-FAP-12X16"]);
  assert.throws(() => parseArgs([], {}), /PRODIGI_SANDBOX_API_KEY/);
});

test(
  "the live sandbox still matches the committed fixture",
  { skip: !process.env.PRODIGI_SANDBOX_API_KEY },
  async () => {
    const live = await captureProducts({
      base: PRODIGI_SANDBOX_API_BASE,
      key: process.env.PRODIGI_SANDBOX_API_KEY!,
      skus: DEFAULT_SKUS,
    });
    assert.equal(
      JSON.stringify(live.products),
      JSON.stringify(fixture.products),
      "the sandbox catalogue drifted from tests/fixtures/prodigi/products.json; re-run the capture",
    );
  },
);

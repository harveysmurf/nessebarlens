/**
 * Issue #143 follow-up: the browser flow's dev server was started without the
 * environment its specs assert on, so two of the eight specs could not pass no
 * matter what the secrets were — and neither failure looked like a config
 * problem.
 *
 *   - Prodigi is explicit-host: prodigiApiBase() throws unless PRODIGI_API_BASE
 *     is an allowlisted host, so /api/quote answered 503 and the physical-print
 *     spec waited on a Checkout button that could never enable.
 *   - A physical order fails closed without PRINT_ASSET_HMAC_SECRET (503 "Print
 *     fulfillment is not configured"), so the same spec could not reach Stripe
 *     even once the quote worked.
 *
 * Both are asserted here against playwright.config.ts rather than trusted: a
 * harness that drops one passthrough takes a spec down to a green skip.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const config = fs.readFileSync(path.join(root, "playwright.config.ts"), "utf8");

const webServerEnv = config.match(/webServer:\s*\{[\s\S]*?env:\s*\{([\s\S]*?)\n {4}\},/);
assert.ok(webServerEnv, "playwright.config.ts must declare a webServer env block");

test("the dev server gets the Prodigi sandbox host and key the quote route requires", () => {
  // The base is pinned, never inherited: an inherited PRODIGI_API_BASE could be
  // a live host, and the flow would then quote against a live account.
  assert.match(
    webServerEnv[1],
    /PRODIGI_API_BASE:\s*"https:\/\/api\.sandbox\.prodigi\.com"/,
    "the harness must pin the sandbox host explicitly",
  );
  assert.match(
    webServerEnv[1],
    /PRODIGI_SANDBOX_API_KEY:\s*process\.env\.PRODIGI_SANDBOX_API_KEY/,
    "the sandbox key must reach the dev server",
  );
});

test("the dev server gets PRINT_ASSET_HMAC_SECRET, or a physical order cannot be charged", () => {
  assert.match(
    webServerEnv[1],
    /PRINT_ASSET_HMAC_SECRET:\s*process\.env\.PRINT_ASSET_HMAC_SECRET/,
    "without it /api/checkout answers 503 and the physical spec cannot reach Stripe",
  );
});

test("the CI job passes the same three values to the harness", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  for (const name of [
    "STRIPE_SECRET_KEY",
    "PRODIGI_SANDBOX_API_KEY",
    "PRINT_ASSET_HMAC_SECRET",
  ]) {
    assert.match(job[1], new RegExp(`${name}: \\$\\{\\{ secrets\\.\\w+ \\}\\}`), `the job must pass ${name}`);
  }
});

test("the digital-licence spec selects digital before asserting the digital price", () => {
  // The configurator opens on a physical format, so the price label holds a
  // Prodigi quote (or "—") and the digital price never appears unselected. The
  // spec used to assert it there, which is why it failed on a server whose
  // Prodigi env was complete.
  const spec = fs.readFileSync(path.join(root, "e2e", "smoke.spec.ts"), "utf8");
  const select = spec.search(/getByText\(\/digital copy\/i\)\.click\(\)/);
  const price = spec.search(/getByText\(`€\$\{DIGITAL_PRICE_EUR/);
  assert.ok(select !== -1, "the spec must select the digital format");
  assert.ok(price !== -1 && price > select, "the price assertion must come after the selection");
});
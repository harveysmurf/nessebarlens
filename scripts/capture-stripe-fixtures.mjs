#!/usr/bin/env node
/**
 * Capture real Stripe test-mode webhook events as contract-test fixtures (#225).
 *
 * Dependabot PRs have no Stripe secrets, so tests/stripe-contract.test.mts runs
 * against files in tests/fixtures/stripe/. Until they are captured here they
 * are hand-built from the API reference (see that folder's README). This script
 * replaces them with what Stripe actually sent: the newest checkout, refund and
 * dispute events in the account, scrubbed of personal data.
 *
 * Test-mode only: it refuses any key that is not sk_test_.
 *
 * Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/capture-stripe-fixtures.mjs
 * Exits 0 when all three fixtures were written, 1 (writing nothing) otherwise.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { testModeKey } from "./verify-stripe-integration.mjs";

/** Must equal STRIPE_API_VERSION in src/lib/stripe.ts; the contract test checks. */
export const STRIPE_API_VERSION = "2026-09-30.endive";

// The sk_test_ guard is shared with the live check rather than copied.
export { testModeKey };

const FIXTURE_DIR = path.join(import.meta.dirname, "..", "tests", "fixtures", "stripe");

/** Metadata keys our checkout route always writes. */
const OUR_METADATA_KEYS = ["photoSlug", "format", "size", "quoteEur"];
const PHYSICAL_FORMATS = ["giclee", "framed", "canvas"];

export const FIXTURE_TYPES = [
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
];

const TEST_ADDRESS = {
  city: "Nessebar",
  country: "BG",
  line1: "1 Test Street",
  line2: null,
  postal_code: "8230",
  state: null,
};

/** Fixed replacement per key; null-valued keys stay null so shapes are kept. */
const SCRUBBED_VALUES = {
  name: "Test Buyer",
  individual_name: "Test Buyer",
  business_name: "Test Buyer",
  customer_name: "Test Buyer",
  phone: null,
  client_secret: null,
  ip_address: null,
  customer_purchase_ip: null,
  receipt_url: "https://pay.stripe.com/receipts/payment/test_receipt",
  fingerprint: "TestFingerprint0001",
  last4: "4242",
  idempotency_key: null,
};

/**
 * Deep copy of `value` with personal data replaced. Pure: nothing is mutated.
 * Keys are matched by name anywhere in the tree, because Stripe repeats the
 * same personal fields across customer_details, billing_details and shipping.
 */
export function scrub(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value === null || typeof value !== "object") {
    if (value === null) return null;
    if (/(^|_)email$/.test(key)) return "buyer@example.com";
    if (key in SCRUBBED_VALUES) return SCRUBBED_VALUES[key];
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "address" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubAddress(v);
    } else {
      out[k] = scrub(v, k);
    }
  }
  return out;
}

function scrubAddress(address) {
  const out = {};
  for (const [k, v] of Object.entries(address)) {
    out[k] = k in TEST_ADDRESS && v !== null ? TEST_ADDRESS[k] : v;
  }
  return out;
}

function hasOurMetadata(object) {
  const meta = object?.metadata;
  return !!meta && OUR_METADATA_KEYS.every((k) => typeof meta[k] === "string");
}

/**
 * The newest checkout event with our metadata, preferring one for a physical
 * format that carries shipping details. `events` is newest first, as the API
 * returns it.
 */
export function pickCheckoutEvent(events) {
  const ours = events.filter((e) => hasOurMetadata(e.data?.object));
  const physical = ours.find((e) => {
    const o = e.data.object;
    return (
      PHYSICAL_FORMATS.includes(o.metadata.format) &&
      !!(o.collected_information?.shipping_details ?? o.shipping_details)
    );
  });
  return physical ?? ours[0] ?? null;
}

export function pickEvent(type, events) {
  return type === "checkout.session.completed" ? pickCheckoutEvent(events) : (events[0] ?? null);
}

export function fixtureFileName(type) {
  return `${type}.json`;
}

export async function main() {
  const stripe = new Stripe(testModeKey(process.env.STRIPE_SECRET_KEY), {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });

  const found = [];
  const missing = [];
  for (const type of FIXTURE_TYPES) {
    const list = await stripe.events.list({ type, limit: 20 });
    const picked = pickEvent(type, list.data);
    if (picked) found.push([type, picked]);
    else missing.push(type);
  }

  if (missing.length > 0) {
    for (const type of missing) {
      console.error(
        `capture-stripe: no usable ${type} in the last 30 days: ` +
          (type === "checkout.session.completed"
            ? "make one sandbox purchase first (npm run test:e2e does)"
            : "refund or dispute a sandbox payment (scripts/verify-stripe-integration.mjs creates a dispute)"),
      );
    }
    console.error("capture-stripe: nothing written");
    return 1;
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [type, event] of found) {
    const file = path.join(FIXTURE_DIR, fixtureFileName(type));
    writeFileSync(file, `${JSON.stringify(scrub(event), null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), file)} (${event.id})`);
  }
  console.log("Review the diff for anything personal before committing.");
  return 0;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("capture-stripe: unexpected error:", e?.message ?? e);
      process.exit(1);
    },
  );
}

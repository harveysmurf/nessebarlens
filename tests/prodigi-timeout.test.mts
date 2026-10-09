import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { memoryOrdersStore } from "./fake-orders-store.mts";

import {
  isProdigiTimeout,
  PRODIGI_ORDER_TIMEOUT_MS,
  PRODIGI_QUOTE_TIMEOUT_MS,
  prodigiTimeoutSignal,
} from "../src/infrastructure/prodigi/prodigi-config.ts";
import { isRetryableProdigiReason } from "../src/domain/ordering/prodigi-policy.ts";
import { type OrderRecipient } from "../src/infrastructure/prodigi/prodigi-order.ts";
import { quotePhysical } from "../src/infrastructure/prodigi/prodigi-quote.ts";
import { createProdigiOrder } from "../src/infrastructure/prodigi/prodigi-order.ts";
import { fulfillCheckoutSession } from "../src/application/fulfillment/fulfillment.ts";
import { parseOrderRecord } from "../src/domain/ordering/order-decision.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.test",
  phone: null,
};

const ENV_KEYS = [
  "PRODIGI_API_BASE",
  "PRODIGI_SANDBOX_API_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "PRINT_ASSET_HMAC_SECRET",
] as const;

/**
 * A fetch that never settles, the way a hung Prodigi connection behaves.
 *
 * The signal is the only thing that can end it: a plain `new Promise(() => {})`
 * with no signal would hang the test the same way it hangs the request, which
 * is the failure this issue is about and not something a test may reproduce.
 */
function hangingFetch(): typeof fetch {
  return (async (_input: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation timed out.", "TimeoutError"));
      });
    });
  }) as unknown as typeof fetch;
}

test("a timeout budget exists for each Prodigi call", () => {
  // Two numbers because two deadlines apply, and the order one has to be the
  // longer: it runs inside the Stripe webhook, where the answer still has to
  // reach Stripe as a 5xx with time to spare.
  assert.ok(PRODIGI_QUOTE_TIMEOUT_MS > 0);
  assert.ok(PRODIGI_ORDER_TIMEOUT_MS > PRODIGI_QUOTE_TIMEOUT_MS);
  // Below the Stripe response window, or a timeout would still blow it.
  assert.ok(PRODIGI_ORDER_TIMEOUT_MS < 20_000);
});

test("a hung quote fails with a timeout rather than hanging", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  globalThis.fetch = hangingFetch();
  try {
    // A short budget so the test proves the bound is real rather than waiting
    // out the production one: the production value is asserted above.
    const started = Date.now();
    const result = await quotePhysical({
      format: "giclee",
      size: "50x70",
      frame: null,
      destinationCountryCode: "BG",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "timeout");
    assert.match(result.ok === false ? result.message : "", /timed out/);
    assert.ok(
      Date.now() - started < PRODIGI_QUOTE_TIMEOUT_MS + 2_000,
      "the quote gave up on its own deadline rather than hanging",
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a hung order is a retryable timeout, not a dead end", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  process.env.PRINT_ASSET_HMAC_SECRET = "prodigi-timeout-hmac-secret-32ch!";
  globalThis.fetch = hangingFetch();
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: RECIPIENT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    // timeout + retryable is the pair that matters: the webhook answers 5xx and
    // the record stays eligible for a redelivery, which is the only way a paid
    // print still gets placed.
    assert.equal(result.kind, "timeout");
    assert.equal(result.reason, "prodigi-timeout");
    assert.equal(result.status, null, "no HTTP status was ever received");
    assert.match(result.message, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

/**
 * A Prodigi that answers 200 with headers and then stalls mid-body — the shape
 * the fetch-level abort cannot see, because the fetch already resolved.
 */
function stalledBodyFetch(bodyFailure: () => unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw bodyFailure();
    },
  })) as unknown as typeof fetch;
}

test("a body read that dies mid-stream is a retryable timeout, not a lost order", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  process.env.PRINT_ASSET_HMAC_SECRET = "prodigi-timeout-hmac-secret-32ch!";
  globalThis.fetch = stalledBodyFetch(
    () => new DOMException("The operation timed out.", "TimeoutError"),
  );
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: RECIPIENT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    // The regression this guards: an empty body reads as "success with no order
    // id", which is terminal. A paid order would never be placed, and the
    // webhook would answer 200 so Stripe would never redeliver it.
    assert.equal(result.kind, "timeout");
    assert.equal(result.reason, "prodigi-timeout");
    assert.match(result.message, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a genuinely empty 200 body is still the terminal missing-id failure", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  process.env.PRINT_ASSET_HMAC_SECRET = "prodigi-timeout-hmac-secret-32ch!";
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => "",
  })) as unknown as typeof fetch;
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: RECIPIENT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    // The other half of the same distinction: no abort, no id. Retrying cannot
    // fix a contract change, so this stays terminal.
    assert.equal(result.kind, "client");
    assert.equal(result.reason, "prodigi-error");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("the timeout reason is retryable, which is what makes the 5xx safe", () => {
  assert.equal(isRetryableProdigiReason("prodigi-timeout"), true);
});

test("a timeout on the order path is stored non-terminal and answered 5xx", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  process.env.PRINT_ASSET_HMAC_SECRET = "prodigi-timeout-hmac-secret-32ch!";
  globalThis.fetch = hangingFetch();
  const store = memoryOrdersStore();
  try {
    const result = await fulfillCheckoutSession({
      sessionId: "cs_test_abcdefgh",
      paymentStatus: "paid",
      currency: "eur",
      amountTotal: 1999,
      metadata: {
        photoSlug: SAMPLE_SLUG,
        format: "giclee",
        size: "50x70",
        frame: "",
        quoteEur: "15",
        merchandiseEur: "15",
        shippingEur: "4.99",
        sku: "GLOBAL-FAP-12X16",
      },
      shippingDetails: {
        name: "Test Buyer",
        address: {
          line1: "1 Harbor St",
          city: "Nessebar",
          state: "",
          postal_code: "8230",
          country: "BG",
        },
      },
      customerEmail: "buyer@example.test",
      customerPhone: null,
      prodigiKeyConfigured: true,
      now: "2026-01-01T00:00:00.000Z",
      store,
    });
    // 5xx so Stripe redelivers; the record has to survive the round trip
    // through parseOrderRecord, or the retry has nothing to pick up.
    assert.equal(result.httpStatus, 500);
    const stored = parseOrderRecord(
      (await store.getOrder("cs_test_abcdefgh"))!,
    );
    assert.notEqual(stored, null, "the stored record must be readable");
    assert.equal(stored!.reason, "prodigi-timeout");
    assert.equal(stored!.terminal, false, "a redelivery must still be allowed");
    assert.equal(stored!.masterKey, null);
    assert.equal(stored!.prodigiOrderId, null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a non-timeout network failure is still prodigi-unavailable", async () => {
  // The timeout branch must not swallow every rejection: a DNS failure has no
  // deadline behind it and must keep the reason it always had.
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  process.env.PRINT_ASSET_HMAC_SECRET = "prodigi-timeout-hmac-secret-32ch!";
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: RECIPIENT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "prodigi-unavailable");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("both Prodigi fetches actually pass a signal", () => {
  // A timeout budget nothing passes is a constant with a comment. Assert the
  // fetch call carries one, in both callers, on the AST-visible option object.
  const root = path.join(import.meta.dirname, "..", "src/infrastructure/prodigi");
  for (const rel of ["prodigi-quote.ts", "prodigi-order.ts"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const calls = [...src.matchAll(/await fetch\(/g)];
    assert.ok(calls.length > 0, `${rel} has a Prodigi fetch`);
    for (const call of calls) {
      const window = src.slice(call.index, call.index + 700);
      assert.match(
        window,
        /signal,/,
        `${rel} fetches without a signal: a timeout budget nothing passes is a constant with a comment`,
      );
    }
  }
});

test("isProdigiTimeout reads the signal, and does not fire on an unrelated error", () => {
  const signal = prodigiTimeoutSignal(50);
  assert.equal(isProdigiTimeout(new TypeError("fetch failed"), signal), false);
  assert.equal(isProdigiTimeout("a string", signal), false);
  assert.equal(isProdigiTimeout(null, signal), false);
  assert.equal(isProdigiTimeout({ name: "SomethingElse" }, signal), false);
  // After the deadline, the signal itself is the authority.
  const expired = AbortSignal.timeout(1);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(expired.aborted, true);
      assert.equal(isProdigiTimeout(new Error("unrelated"), expired), true);
      resolve();
    }, 20);
  });
});

test("a TimeoutError is recognised even if the signal never marked itself", () => {
  // The defensive second reading: a runtime that rejects with TimeoutError
  // without aborting the signal still means we gave up on it.
  const signal = prodigiTimeoutSignal(60_000);
  const timeout = new DOMException("timed out", "TimeoutError");
  assert.equal(signal.aborted, false);
  assert.equal(isProdigiTimeout(timeout, signal), true);
});

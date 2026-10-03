/**
 * Prodigi cancellation (#101).
 *
 * Cancelling a print is a courtesy, not the webhook's contract, so every one of
 * these cases is about *not throwing*: the caller has already revoked the
 * customer's access and must never be taken down by this. That is the property
 * pinned here — a misconfigured deploy, a network failure, a 405 from a stage
 * Prodigi will not cancel, and a success all come back as a result.
 *
 * The order-id guard is the other half. The id goes into a URL path segment,
 * so an id carrying "../" or a slash would retarget the request at some other
 * Prodigi endpoint with our API key attached.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelProdigiOrder,
  isSafeProdigiOrderId,
  prodigiCancelUrl,
} from "../src/lib/prodigi-cancel.ts";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

const ENV_KEYS = [
  "PRODIGI_API_BASE",
  "PRODIGI_SANDBOX_API_KEY",
  "PRODIGI_API_KEY",
] as const;

function withProdigiEnv<T>(body: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.PRODIGI_API_BASE;
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  delete process.env.PRODIGI_API_KEY;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  try {
    return body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withFetch<T>(
  replacement: typeof fetch,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("the cancel url is the order's own cancel endpoint", () => {
  assert.equal(
    prodigiCancelUrl("ord_abc123", "https://api.sandbox.prodigi.com"),
    "https://api.sandbox.prodigi.com/v4.0/orders/ord_abc123/cancel",
  );
});

test("an order id that could escape its path segment is refused", () => {
  // The id is interpolated into a URL, so a traversal id would send our API
  // key to whatever endpoint the caller chose.
  for (const bad of [
    "../quotes",
    "ord/abc",
    "ord abc",
    "",
    "ord_abc\nX-Evil: 1",
    "ord_abc?x=1",
    "a".repeat(129),
  ]) {
    assert.equal(isSafeProdigiOrderId(bad), false, bad);
    assert.throws(
      () => prodigiCancelUrl(bad, "https://api.sandbox.prodigi.com"),
      /unsafe Prodigi order id/,
    );
  }
  assert.equal(isSafeProdigiOrderId("ord_abc123"), true);
  assert.equal(isSafeProdigiOrderId("A-b_9"), true);
  assert.equal(isSafeProdigiOrderId(42), false);
  assert.equal(isSafeProdigiOrderId(null), false);
});

test("a successful cancel posts the key and reports the status", async () => {
  await withProdigiEnv(() =>
    withFetch(
      (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
        assert.equal(
          String(url),
          "https://api.sandbox.prodigi.com/v4.0/orders/ord_abc123/cancel",
        );
        assert.equal(init?.method, "POST");
        assert.equal(init?.headers?.["X-API-Key"], "sandbox-key");
        return new Response(JSON.stringify({ status: { stage: "cancelled" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      async () => {
        const result = await cancelProdigiOrder({
          prodigiOrderId: "ord_abc123",
          sessionId: "cs_test_abcdefgh",
        });
        assert.deepEqual(result, { ok: true, status: 200 });
      },
    ),
  );
});

test("a Prodigi rejection is a result carrying the status, not a throw", async () => {
  // 405 is what the sandbox answered when this was written, and it is the
  // honest shape of "Prodigi will not cancel this stage": log it, revoke
  // anyway, let a human decide.
  await withProdigiEnv(() =>
    withFetch(
      (async () => new Response("{}", { status: 405 })) as typeof fetch,
      async () => {
        const result = await cancelProdigiOrder({
          prodigiOrderId: "ord_abc123",
          sessionId: "cs_test_abcdefgh",
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.status, 405);
        assert.match(String(result.ok === false && result.message), /405/);
      },
    ),
  );
});

test("a network failure is a result, not a throw", async () => {
  await withProdigiEnv(() =>
    withFetch(
      (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
      async () => {
        const result = await cancelProdigiOrder({
          prodigiOrderId: "ord_abc123",
          sessionId: "cs_test_abcdefgh",
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.reason, "prodigi-cancel-unreachable");
      },
    ),
  );
});

test("an unconfigured deploy is reported as unconfigured, not as Prodigi failing", async () => {
  // The same distinction prodigi-config.ts draws for the quote and order paths:
  // "this deploy has no key" and "Prodigi is unhealthy" are different facts
  // for whoever is on call.
  const saved = { ...process.env };
  delete process.env.PRODIGI_API_BASE;
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  try {
    const result = await cancelProdigiOrder({
      prodigiOrderId: "ord_abc123",
      sessionId: "cs_test_abcdefgh",
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.reason,
      "prodigi-cancel-unconfigured",
    );
    assert.match(String(result.ok === false && result.message), /PRODIGI_API_BASE/);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
test("a thrown non-Error still names the failure", async () => {
  // fetch rejects with whatever it rejected with, including values that have
  // no .message. An interpolated undefined in the log line is the only clue
  // the operator would otherwise get.
  await withProdigiEnv(() =>
    withFetch(
      (async () => {
        throw "socket hang up";
      }) as typeof fetch,
      async () => {
        const result = await cancelProdigiOrder({
          prodigiOrderId: "ord_abc123",
          sessionId: "cs_test_abcdefgh",
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.message, "network-error");
      },
    ),
  );
});

test("an unsafe order id is refused before any request is made", async () => {
  // cancelProdigiOrder takes the id from a stored record, not from a request,
  // but the id still lands in a URL path with our API key attached. Refusing
  // it here means the guard is not something a future caller can forget.
  await withProdigiEnv(() =>
    withFetch(
      (async () => {
        throw new Error("no request may be made for an unsafe id");
      }) as typeof fetch,
      async () => {
        const result = await cancelProdigiOrder({
          prodigiOrderId: "../quotes",
          sessionId: "cs_test_abcdefgh",
        });
        assert.equal(result.ok, false);
        assert.equal(
          result.ok === false && result.reason,
          "prodigi-cancel-unconfigured",
        );
      },
    ),
  );
});

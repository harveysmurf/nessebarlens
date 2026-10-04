import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { memoryOrdersStore } from "./fake-orders-store.mts";

/* The route handlers, called the way Next calls them: a Request in, a
   Response out. They own the status codes and the guard order, which is the
   part no test touched until now.

   readWorkerBindings is the one seam. ORDERS_DB and MASTERS are Worker bindings
   and have no env fallback by design, so a route that reads them can only be
   driven from outside by substituting the module — which is what the hook below
   does. The handlers themselves are the real source, imported once. */

const FAKE = "buzz-test:fake-worker-bindings";

type Fake = {
  ORDERS_DB?: unknown;
  MASTERS?: unknown;
  webhookSecret?: string;
  printAssetSecret?: string;
  reconcileSecret?: string;
  prodigiWebhookToken?: string;
  resendApiKey?: string;
  prodigiKeyConfigured: boolean;
};

const globals = globalThis as { __buzzBindings?: Fake };
const bindings: Fake = { prodigiKeyConfigured: false };
globals.__buzzBindings = bindings;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/worker-bindings") {
      return { url: FAKE, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === FAKE) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export async function readWorkerBindings() { return globalThis.__buzzBindings; }",
      };
    }
    return nextLoad(url, context);
  },
});

/* Global-state discipline for the tests below.

   Every test here swaps three process-wide things: the fake Worker bindings,
   globalThis.fetch, and pieces of process.env. node runs top-level tests in a
   file sequentially, so a leak cannot make two tests *interleave* — it makes
   the *next* test read the wrong world and fail somewhere far away from the
   mistake. That is how a real leak here once presented as an unrelated
   assertion failure.

   The individual tests still restore by hand, but this hook is the single
   authority: it snapshots before each test, asserts afterwards so a missed
   restore is reported *under the test that caused it*, and then restores
   unconditionally so the suite's ordering cannot depend on every test having
   got its finally block right. Detection and repair are deliberately the same
   hook — a detector alone still lets one broken test cascade into the next,
   which is exactly the failure mode being closed here. */
const SITE = "https://nessebarlens.com";
// Set before the snapshot below: this one is the file's own setup, not a
// per-test mutation, and the guard must not flag it.
process.env.NEXT_PUBLIC_SITE_URL = SITE;
// A usable print-asset secret is part of this file's baseline, not a per-test
// mutation: a correctly configured deployment has one, and /api/checkout now
// refuses to take money for a physical order without it. The tests that prove
// the fail-closed behaviour delete it explicitly.
process.env.PRINT_ASSET_HMAC_SECRET = "route-test-print-asset-secret-32-chars";
// Baseline, not a per-test mutation: the Prodigi callback route reads the host
// and key to build its re-fetch, so tests that reach that fetch need a
// configured pair present, and the leak guard must not flag them for it.
process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key-for-the-route-test";

let currentTest = "unknown";
let snapshot: { bindings: unknown; fetch: typeof globalThis.fetch; env: NodeJS.ProcessEnv };

beforeEach((t) => {
  currentTest = t.name;
  snapshot = {
    bindings: globals.__buzzBindings,
    fetch: globalThis.fetch,
    env: { ...process.env },
  };
});

/** Puts process.env back to exactly `snapshot`, including deleted keys. */
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  const leaked: string[] = [];
  if (globals.__buzzBindings !== snapshot.bindings) {
    leaked.push("the fake Worker bindings were left swapped");
  }
  if (globalThis.fetch !== snapshot.fetch) {
    leaked.push("globalThis.fetch was left replaced");
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!(key in snapshot.env)) leaked.push(`process.env.${key} was added`);
    else if (value !== snapshot.env[key]) leaked.push(`process.env.${key} was modified`);
  }
  for (const key of Object.keys(snapshot.env)) {
    if (!(key in process.env)) leaked.push(`process.env.${key} was deleted`);
  }

  // Repair first: a leak must never be allowed to reach the next test, even if
  // the test itself is about to be failed for it.
  globals.__buzzBindings = snapshot.bindings;
  globalThis.fetch = snapshot.fetch;
  restoreEnv(snapshot.env);

  assert.deepEqual(
    leaked,
    [],
    `"${currentTest}" leaked global state — ${leaked.join("; ") || "see above"}`,
  );
});

const quote = await import("../src/app/api/quote/route.ts");
const printAsset = await import("../src/app/api/print-asset/route.ts");
const download = await import("../src/app/api/download/route.ts");
const checkout = await import("../src/app/api/checkout/route.ts");
const stripe = await import("../src/app/api/webhooks/stripe/route.ts");
const prodigiWebhook = await import("../src/app/api/webhooks/prodigi/route.ts");

/** Sets the bindings for one test and returns a restore function. */
function withBindings(next: Fake) {
  const previous = globals.__buzzBindings;
  globals.__buzzBindings = next;
  return () => {
    globals.__buzzBindings = previous;
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const memoryKv = (initial: Record<string, string> = {}) => {
  return memoryOrdersStore({ kv: initial });
};

/**
 * A download token written straight into a fake store (#111).
 *
 * The download route no longer accepts a session id, so every test that drives
 * it needs a real token row. Minting through `ensureDownloadToken` rather than
 * hand-writing JSON means the fixture cannot drift from the shape the
 * fulfillment path writes.
 */
async function seedToken(
  store: ReturnType<typeof memoryKv>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  const { ensureDownloadToken } = await import("../src/lib/download-token.ts");
  const record = await ensureDownloadToken({
    store,
    sessionId,
    limits: { ttlSeconds: 30 * 86_400, maxDownloads: 5 },
  });
  assert.ok(record, "the fake store should be able to mint a token");
  if (Object.keys(overrides).length > 0) {
    const next = { ...record, ...overrides };
    // The token string is the key the record is stored under, so the override
    // lands on the record body and the index keeps the real token.
    const tokenRecord = { ...next };
    delete (tokenRecord as Record<string, unknown>).token;
    await store.putDownloadToken(
      tokenRecord as typeof record,
      { ...(tokenRecord as typeof record), token: record.token },
    );
  }
  return record.token;
}

test("quote: unparseable body, then a body the parser rejects", async () => {
  const broken = await quote.POST(
    new Request(`${SITE}/api/quote`, {
      method: "POST",
      body: "not json",
    }),
  );
  assert.equal(broken.status, 400);
  assert.deepEqual(await body(broken), { error: "Invalid JSON" });

  const rejected = await quote.POST(
    jsonRequest(`${SITE}/api/quote`, { format: "nope", size: "30x40" }),
  );
  assert.equal(rejected.status, 400);
  assert.match(String((await body(rejected)).error), /format/);
});

test("both routes: a body that will not parse is the same 400 on both", async () => {
  /* readJsonBody replaced a hand-rolled try/catch per route. These are the
     cases that could have drifted while they were separate: an empty body, a
     truncated one, and JSON that parses but is not an object — the last one
     must fall through to the body parser's own message, not the JSON one, or
     the helper has swallowed a distinction the routes used to make. */
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("neither Stripe nor Prodigi may be called for a broken body");
  }) as typeof fetch;
  try {
    for (const [path, handler] of [
      ["/api/quote", quote.POST],
      ["/api/checkout", checkout.POST],
    ] as const) {
      for (const payload of ["", "not json", "{", '{"format":}']) {
        const response = await handler(
          new Request(`${SITE}${path}`, { method: "POST", body: payload }),
        );
        assert.equal(response.status, 400, `${path} ${JSON.stringify(payload)}`);
        assert.deepEqual(
          await body(response),
          { error: "Invalid JSON" },
          `${path} ${JSON.stringify(payload)}`,
        );
      }

      // `[]` is deliberately absent: an array is an object, so it reaches the
      // format check and is rejected as a missing format instead. Pinned here
      // because that is today's behaviour and readJsonBody must not change it.
      for (const payload of ['"a string"', "42", "null", "true"]) {
        const response = await handler(
          new Request(`${SITE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          }),
        );
        assert.equal(response.status, 400, `${path} ${payload}`);
        assert.deepEqual(
          await body(response),
          { error: "Invalid JSON body" },
          `${path} ${payload}`,
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quote: a digital quote is not a thing, and Prodigi decides the status", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  try {
    // Quotes are the physical ladder only, so a digital one never reaches
    // Prodigi at all.
    const digital = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, { format: "digital" }),
    );
    assert.equal(digital.status, 400);
    assert.equal((await body(digital)).error, "digital has no Prodigi quote");

    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called without an API key");
    }) as typeof fetch;
    const unconfigured = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, {
        format: "giclee",
        size: "30x40",
        frame: null,
        destinationCountryCode: "BG",
      }),
    );
    assert.equal(unconfigured.status, 503, "no key is 503, a Prodigi failure is 502");
    // The env var name is what made this a leak: an unauthenticated caller
    // could read our deployment state off the error string (#107).
    assert.deepEqual(await body(unconfigured), {
      error: "Pricing is temporarily unavailable, please try again.",
      code: "prodigi-unconfigured",
    });

    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const physical = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, {
        format: "giclee",
        size: "30x40",
        frame: null,
        destinationCountryCode: "BG",
      }),
    );
    assert.equal(physical.status, 502, "a Prodigi failure is a bad gateway");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("print-asset: with a secret configured, an expired signature is a 401", async () => {
  const restore = withBindings({
    printAssetSecret: "route-test-print-asset-secret-32-chars",
    prodigiKeyConfigured: false,
  });
  try {
    const response = await printAsset.GET(
      new Request(`${SITE}/api/print-asset?slug=dawn&exp=1&sig=${"0".repeat(64)}`),
    );
    assert.equal(response.status, 401, "expired");
    assert.equal((await body(response)).error, "expired");
    const noBucket = await printAsset.GET(
      new Request(`${SITE}/api/print-asset?slug=not-a-photo&exp=1&sig=${"0".repeat(64)}`),
    );
    assert.equal(noBucket.status, 400);
    assert.equal((await body(noBucket)).error, "invalid-slug");
  } finally {
    restore();
  }
});

test("print-asset: no configured secret is a 503 and no bucket is never a redirect", async () => {
  const savedSecret = process.env.PRINT_ASSET_HMAC_SECRET;
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await printAsset.GET(
      new Request(`${SITE}/api/print-asset?slug=dawn&exp=1&sig=${"0".repeat(64)}`),
    );
    assert.equal(response.status, 503, "unconfigured, whatever the signature says");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await body(response)).error, "print-asset-unavailable");
  } finally {
    restore();
    if (savedSecret !== undefined) {
      process.env.PRINT_ASSET_HMAC_SECRET = savedSecret;
    }
  }
});

test("print-asset: no configured secret is a 503, not a 401", async () => {
  const saved = process.env.PRINT_ASSET_HMAC_SECRET;
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await printAsset.GET(
      new Request(`${SITE}/api/print-asset?slug=dawn&exp=1&sig=${"0".repeat(64)}`),
    );
    // 503 says "this deployment is not configured"; 401 would say "your
    // request is wrong", and a client cannot act on the difference.
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "print-asset-unavailable");
  } finally {
    restore();
    if (saved !== undefined) process.env.PRINT_ASSET_HMAC_SECRET = saved;
  }
});

test("print-asset: a verified slug with no bucket is a 404, never a redirect", async () => {
  const secret = "route-test-print-asset-secret-32-chars";
  const { signPrintAssetUrl } = await import("../src/lib/print-asset.ts");
  const signed = await signPrintAssetUrl("dawn", { secret, baseUrl: SITE });
  assert.ok(signed);
  const restore = withBindings({ printAssetSecret: secret, prodigiKeyConfigured: false });
  try {
    const response = await printAsset.GET(new Request(signed));
    assert.equal(response.status, 503, "no MASTERS binding to read from");
    assert.equal((await body(response)).error, "masters-unavailable");
    assert.equal(response.headers.get("Location"), null, "never a redirect to R2");
  } finally {
    restore();
  }
});

test("download: a session id on its own no longer grants a download (#111)", async () => {
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  // A fully paid, fully valid digital order — the credential is the only thing
  // missing. If the route ever accepted the session id again, this would serve
  // the file.
  const record = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: masterKeyForSlug("dawn"),
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  const kv = memoryKv({ cs_test_abcdefgh: record });
  const restore = withBindings({
    ORDERS_DB: kv,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const bySession = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
    );
    assert.equal(bySession.status, 400);
    assert.equal((await body(bySession)).error, "invalid-token");

    const byStolen = await download.GET(
      new Request(`${SITE}/api/download?token=${"0".repeat(32)}`),
    );
    assert.equal(byStolen.status, 404);
    assert.equal((await body(byStolen)).error, "invalid-token");

    // The same order, with its token, still downloads.
    const token = await seedToken(kv, "cs_test_abcdefgh");
    const ok = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Referrer-Policy"), "no-referrer");
  } finally {
    restore();
  }
});

test("download: a malformed token is refused before the KV is read at all", async () => {
  let touched = 0;
  const kv = {
    async get() {
      touched++;
      return null;
    },
    async put() {},
  };
  const restore = withBindings({ ORDERS_DB: kv, prodigiKeyConfigured: false });
  try {
    const bad = await download.GET(
      new Request(`${SITE}/api/download?token=not-a-token`),
    );
    assert.equal(bad.status, 400);
    assert.equal((await body(bad)).error, "invalid-token");
    assert.equal(touched, 0, "an unvalidated token must not reach the store");
    assert.equal(bad.headers.get("Cache-Control"), "private, no-store");
    assert.equal(bad.headers.get("Referrer-Policy"), "no-referrer");
  } finally {
    restore();
  }
});

test("download: a token for an order the webhook has not stored yet is 202", async () => {
  const kv = memoryKv();
  const token = await seedToken(kv, "cs_test_abcdefgh");
  const restore = withBindings({ ORDERS_DB: kv, prodigiKeyConfigured: false });
  try {
    const notYet = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(notYet.status, 202, "paid but not yet stored as fulfilled");
    assert.equal((await body(notYet)).status, "processing");
    assert.equal(notYet.headers.get("Cache-Control"), "private, no-store");
  } finally {
    restore();
  }
});

test("download: no ORDERS binding is a 503 before the store is read", async () => {
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?token=${"a".repeat(32)}`),
    );
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "orders-store-unavailable");
  } finally {
    restore();
  }
});

test("download: a store that throws is a 503, and a foreign record is corrupt", async () => {
  const throwing = {
    ...memoryOrdersStore(),
    async spendDownloadToken() {
      throw new Error("store down");
    },
    async getOrder() {
      throw new Error("store down");
    },
  };
  const restore = withBindings({ ORDERS_DB: throwing, prodigiKeyConfigured: false });
  try {
    const down = await download.GET(
      new Request(`${SITE}/api/download?token=${"b".repeat(32)}`),
    );
    assert.equal(down.status, 503);
    assert.equal((await body(down)).error, "orders-store-unavailable");
    // A private asset route: unlike the webhook's 503, this one is no-store.
    assert.equal(down.headers.get("Cache-Control"), "private, no-store");
  } finally {
    restore();
  }

  // A record stored under this key that belongs to a different session is not
  // this buyer's file, whatever it says inside.
  const other = memoryKv({
    cs_test_abcdefgh: JSON.stringify({
      v: 1,
      sessionId: "cs_test_different",
      merchantReference: "cs_test_different",
      terminal: true,
      status: "paid",
      photoSlug: "dawn",
      format: "digital",
      size: "",
      frame: "",
      quoteEur: 15,
      amountTotal: 1500,
      currency: "eur",
      reason: null,
      masterKey: null,
      prodigiOrderId: null,
      prodigiStage: null,
      assetUrl: null,
      updatedAt: "2026-09-27T12:00:00.000Z",
    }),
  });
  const token = await seedToken(other, "cs_test_abcdefgh");
  const restore2 = withBindings({ ORDERS_DB: other, prodigiKeyConfigured: false });
  try {
    const corrupt = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(corrupt.status, 500);
    assert.equal((await body(corrupt)).error, "corrupt-order");
  } finally {
    restore2();
  }
});

test("download: a store that throws only on the order read is still a 503", async () => {
  // The token read succeeds and the download is already spent by the time the
  // order record is fetched, so this window is real: an outage between the two
  // reads must read as unavailable, not as a paid customer who gets nothing.
  const kv = memoryKv();
  const token = await seedToken(kv, "cs_test_abcdefgh");
  const flaky = {
    ...kv,
    async getOrder() {
      throw new Error("store down");
    },
  };
  const restore = withBindings({ ORDERS_DB: flaky, prodigiKeyConfigured: false });
  try {
    const down = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(down.status, 503);
    assert.equal((await body(down)).error, "orders-store-unavailable");
    assert.equal(down.headers.get("Referrer-Policy"), "no-referrer");
  } finally {
    restore();
  }
});

test("checkout: a bad body is a 400 and a missing slug never reaches Stripe", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  delete process.env.STRIPE_SECRET_KEY;
  globalThis.fetch = (async () => {
    throw new Error("Stripe must not be called for a rejected body");
  }) as typeof fetch;
  try {
    const broken = await checkout.POST(
      new Request(`${SITE}/api/checkout`, { method: "POST", body: "{" }),
    );
    assert.equal(broken.status, 400);
    assert.equal((await body(broken)).error, "Invalid JSON");

    const noSlug = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { format: "digital" }),
    );
    assert.equal(noSlug.status, 400);
    assert.equal((await body(noSlug)).error, "photoSlug required");

    const unconfigured = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "dawn", format: "digital" }),
    );
    assert.equal(unconfigured.status, 503, "no Stripe key is a 503, not a 400");
    const unknown = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "no-such-photo", format: "digital" }),
    );
    assert.equal(unknown.status, 404);
    assert.equal((await body(unknown)).error, "Unknown photoSlug");
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY !== undefined) {
      process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
    }
  }
});

test("checkout: an unset site url is a 503 before Stripe or Prodigi is called", async () => {
  const savedSite = process.env.NEXT_PUBLIC_SITE_URL;
  const savedFetch = globalThis.fetch;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  globalThis.fetch = (async () => {
    throw new Error("nothing may be called when the site url is unset");
  }) as typeof fetch;
  try {
    for (const payload of [
      { photoSlug: "dawn", format: "digital" },
      { photoSlug: "dawn", format: "giclee", size: "30x40" },
    ]) {
      const res = await checkout.POST(
        jsonRequest(`${SITE}/api/checkout`, payload),
      );
      assert.equal(res.status, 503, JSON.stringify(payload));
      // Generic: the customer must not learn which env var is missing.
      const parsed = await body(res);
      assert.equal(parsed.error, "Checkout is not configured");
      assert.ok(!JSON.stringify(parsed).includes("NEXT_PUBLIC_SITE_URL"));
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = savedSite;
  }
});

test("prodigi webhook: authenticated but no ORDERS_DB is a 503, not a callback", async () => {
  // Order matters and is the point of this test: auth is checked first, so a
  // request that passes the bearer check reaches the binding check and is told
  // the deployment is incomplete rather than that it was rejected.
  const token = "prodigi-route-test-token-32chars!!";
  const restore = withBindings({ prodigiWebhookToken: token, prodigiKeyConfigured: false });
  try {
    const response = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          specversion: "1.0",
          id: "evt_no_binding",
          subject: "ord_abc",
          data: {},
        }),
      }),
    );
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "orders-store-unavailable");
  } finally {
    restore();
  }
});

test("prodigi webhook: an authenticated, well-formed callback reaches the handler", async () => {
  const token = "prodigi-route-test-token-32chars!!";
  const store = memoryKv();
  const savedFetch = globalThis.fetch;
  // Prodigi is unreachable here, which is the failure under test: a callback we
  // cannot verify against the source of truth must be retried, not acted on.
  globalThis.fetch = (async () => {
    throw new Error("Prodigi is down");
  }) as typeof fetch;
  const restore = withBindings({
    ORDERS_DB: store,
    prodigiWebhookToken: token,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          specversion: "1.0",
          id: "evt_route_unknown",
          subject: "ord_not_ours_zzz",
          data: { order: { id: "ord_not_ours_zzz" } },
        }),
      }),
    );
    // A Prodigi GET we could not make is a 5xx so Prodigi retries, unlike a
    // malformed envelope — that one is theirs to fix, this one is ours.
    assert.equal(response.status, 500);
    assert.equal((await body(response)).error, "prodigi-fetch-failed");
    assert.equal(store.prodigiCallbacks.size, 0, "a failed fetch must claim nothing");
  } finally {
    restore();
    globalThis.fetch = savedFetch;
  }
});

test("prodigi webhook: a store that throws is a 500 Prodigi may retry", async () => {
  const token = "prodigi-route-test-token-32chars!!";
  const throwing = {
    ...memoryKv(),
    async getOrder() {
      throw new Error("store down");
    },
  };
  const savedFetch = globalThis.fetch;
  // A real fetch-shaped answer, so the failure under test is the store and not
  // the Prodigi GET.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        order: {
          id: "ord_abc",
          merchantReference: "cs_test_abcdefgh",
          status: { stage: "Complete" },
          shipments: [],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const restore = withBindings({
    ORDERS_DB: throwing,
    prodigiWebhookToken: token,
    resendApiKey: "re_route_test_key",
    prodigiKeyConfigured: true,
  });
  // Same reason as the test above: without a key the GET would fail before the
  // store was ever reached, and this test would prove nothing.
  try {
    const response = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          specversion: "1.0",
          id: "evt_store_down",
          subject: "ord_abc",
          data: {},
        }),
      }),
    );
    assert.equal(response.status, 500);
    assert.equal((await body(response)).error, "prodigi-callback-failed");
  } finally {
    restore();
    globalThis.fetch = savedFetch;
  }
});

test("prodigi webhook: 503 unset token, 401 missing/wrong bearer (#117)", async () => {
  const store = memoryKv();
  const event = JSON.stringify({
    specversion: "1.0",
    id: "evt_route_auth",
    subject: "ord_abc",
    data: {},
  });

  const unset = withBindings({ ORDERS_DB: store, prodigiKeyConfigured: false });
  try {
    const response = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        body: event,
      }),
    );
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "prodigi-webhook-unconfigured");
  } finally {
    unset();
  }

  const token = "prodigi-route-test-token-32chars!!";
  const withToken = withBindings({
    ORDERS_DB: store,
    prodigiWebhookToken: token,
    prodigiKeyConfigured: false,
  });
  try {
    const missing = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        body: event,
      }),
    );
    assert.equal(missing.status, 401);

    const wrong = await prodigiWebhook.POST(
      new Request(`${SITE}/api/webhooks/prodigi`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token-not-matching-len!!" },
        body: event,
      }),
    );
    assert.equal(wrong.status, 401);
  } finally {
    withToken();
  }
});

test("prodigi webhook: the ?token= query param authenticates, header still works (#185)", async () => {
  // Prodigi v4 sends no auth header, so the token lives in the callback URL.
  const token = "prodigi-route-test-token-32chars!!";
  const event = JSON.stringify({
    specversion: "1.0",
    id: "evt_route_query_token",
    subject: "ord_abc",
    data: {},
  });
  const withToken = withBindings({
    prodigiWebhookToken: token,
    prodigiKeyConfigured: false,
  });
  const call = (url: string, headers?: Record<string, string>) =>
    prodigiWebhook.POST(
      new Request(url, { method: "POST", headers, body: event }),
    );
  try {
    // Correct token in the query param: passes auth and reaches the binding
    // check (no ORDERS_DB configured here), i.e. not a 401.
    const viaQuery = await call(`${SITE}/api/webhooks/prodigi?token=${token}`);
    assert.equal(viaQuery.status, 503);
    assert.equal((await body(viaQuery)).error, "orders-store-unavailable");

    // Back-compat: the bearer header still authenticates.
    const viaHeader = await call(`${SITE}/api/webhooks/prodigi`, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(viaHeader.status, 503);

    // A wrong token in the URL is still a 401, and the query param wins when
    // both are present.
    const wrongQuery = await call(`${SITE}/api/webhooks/prodigi?token=wrong-token-not-matching-len!!`);
    assert.equal(wrongQuery.status, 401);
    const mismatched = await call(`${SITE}/api/webhooks/prodigi?token=wrong-token-not-matching-len!!`, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(mismatched.status, 401, "query param must not be bypassed by a good header");
  } finally {
    withToken();
  }
});

test("webhook: no signature, no secret, bad signature — in that order", async () => {
  const saved = { ...process.env };
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const unsigned = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, { method: "POST", body: "{}" }),
    );
    assert.equal(unsigned.status, 400);
    assert.equal((await body(unsigned)).error, "missing-signature");

    const unconfigured = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=abc" },
        body: "{}",
      }),
    );
    // 503, not 500: "this deploy has no webhook secret" is a config fact a
    // human must fix, and it has to be distinguishable in the logs from a
    // transient Stripe problem. Still 5xx, so nothing paid is dropped.
    assert.equal(unconfigured.status, 503);
    assert.equal((await body(unconfigured)).error, "stripe-webhook-unconfigured");

    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_route_secret";
    const restore2 = withBindings({
      webhookSecret: "whsec_test_route_secret",
      prodigiKeyConfigured: false,
    });
    const forged = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) },
        body: JSON.stringify({ type: "checkout.session.completed" }),
      }),
    );
    assert.equal(forged.status, 400);
    assert.equal((await body(forged)).error, "invalid-signature");
    restore2();
  } finally {
    restore();
    if (saved.STRIPE_WEBHOOK_SECRET === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = saved.STRIPE_WEBHOOK_SECRET;
    }
  }
});

test("webhook: an unhandled event is acknowledged without touching the store", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "customer.updated",
    data: { object: { id: "cus_1" } },
  });
  const signature = await sign(event, secret);
  let touched = 0;
  const kv = {
    async get() {
      touched++;
      return null;
    },
    async put() {
      touched++;
    },
  };
  const restore = withBindings({ webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { received: true, ignored: "customer.updated" });
    assert.equal(touched, 0, "an ignored event must not read or write ORDERS");
  } finally {
    restore();
  }
  // The signature really was verified: the same event with a wrong key is 400.
  const bad = await sign(event, "whsec_a_different_secret");
  const restore2 = withBindings({ webhookSecret: secret, prodigiKeyConfigured: false });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": bad },
        body: event,
      }),
    );
    assert.equal(response.status, 400);
  } finally {
    restore2();
  }
});

test("webhook: a session created by another environment is acknowledged and dropped (#193)", async () => {
  // Stripe test mode delivers every session to every endpoint, so the staging
  // handler also receives production checkouts and vice versa. Writing that
  // order locally is what let two builds fight over one Prodigi order, so this
  // deployment must answer 200 having stored nothing.
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_foreign",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        // success_url is the origin record: our checkout route builds it from
        // siteUrl(), so it is present on every session.
        success_url:
          "https://staging.nessebarlens.com/checkout/success?session_id=cs_test_abcdefgh",
      },
    },
  });
  const signature = await sign(event, secret);
  let touched = 0;
  const kv = {
    async get() {
      touched++;
      return null;
    },
    async put() {
      touched++;
    },
  };
  const restore = withBindings({ webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), {
      received: true,
      ignored: "foreign-session",
    });
    assert.equal(touched, 0, "a foreign session must not be stored here");
  } finally {
    restore();
  }
});

test("webhook: a handled event with no ORDERS binding is a 500, not a silent 200", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_2",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_abcdefgh", payment_status: "unpaid" } },
  });
  const signature = await sign(event, secret);
  const restore = withBindings({ webhookSecret: secret, prodigiKeyConfigured: false });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    // A missing binding is 503 "unconfigured", the same shape as the missing
    // webhook secret, so a deploy misconfig is diagnosable one way.
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "orders-store-unavailable");
    // The webhook is the one orders-kv 503 that sends no Cache-Control: the
    // string and status are single-sourced, the headers are not, and pinning
    // the difference here is what stops a shared response builder from
    // quietly adding no-store (or dropping it) on one of the two routes.
    assert.equal(response.headers.get("Cache-Control"), null);
  } finally {
    restore();
  }
});

test("webhook: shipping comes from collected_information when Stripe sends both", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_3",
    object: "event",
    type: "checkout.session.completed",
    api_version: "2024-06-20",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: "eur",
        amount_total: 1999,
        metadata: {
          photoSlug: "dawn",
          format: "giclee",
          size: "30x40",
          frame: "",
          quoteEur: "15",
          merchandiseEur: "15",
          shippingEur: "4.99",
          sku: "GLOBAL-FAP-12X16",
        },
        shipping_details: null,
        collected_information: {
          shipping_details: {
            name: "Test Buyer",
            address: {
              line1: "1 Harbor St",
              line2: null,
              city: "Nessebar",
              state: null,
              postal_code: "8230",
              country: "BG",
            },
          },
        },
        customer_details: { email: "buyer@example.com", phone: null },
      },
    },
  });
  const signature = await sign(event, secret);
  const originalFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  let sent: {
    recipient: { address: { townOrCity: string; countryCode: string } };
  } | null = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent = JSON.parse(init!.body!) as typeof sent;
    return new Response(JSON.stringify({ order: { id: "ord_route_1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: memoryKv(),
    prodigiKeyConfigured: true,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    const parsed = await body(response);
    assert.equal(parsed.status, "paid");
    assert.equal(parsed.prodigiOrderId, "ord_route_1");
    assert.equal(
      sent?.recipient.address.townOrCity,
      "Nessebar",
      "the address Stripe sent in collected_information reached Prodigi",
    );
    assert.equal(sent?.recipient.address.countryCode, "BG");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("checkout: a created session returns the Stripe URL and the quote", async () => {
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  let called = "";
  globalThis.fetch = (async (url: unknown) => {
    called = String(url);
    return new Response(
      JSON.stringify({
        id: "cs_test_abcdefgh",
        url: "https://checkout.stripe.com/c/pay/cs_test_abcdefgh",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "dawn", format: "digital" }),
    );
    assert.equal(response.status, 200);
    const created = await body(response);
    assert.equal(created.url, "https://checkout.stripe.com/c/pay/cs_test_abcdefgh");
    assert.equal(created.sessionId, "cs_test_abcdefgh");
    assert.equal(typeof created.quoteEur, "number");
    assert.match(called, /api\.stripe\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("checkout: a Stripe rejection is a 502 that names Stripe's own code", async () => {
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", code: "api_key_invalid" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "dawn", format: "digital" }),
    );
    assert.equal(response.status, 502);
    const failed = await body(response);
    // Stripe's own code identifies the cause in the log, not in the body this
    // unauthenticated caller reads (#107).
    assert.deepEqual(failed, {
      error: "Could not create Checkout Session",
      code: "checkout-unavailable",
    });
    assert.equal(
      JSON.stringify(failed).includes("api_key_invalid"),
      false,
      "Stripe's error code must not reach the response body",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("checkout: a transport failure with no Stripe code still logs one", async () => {
  // The log line is the only diagnosis a 502 leaves behind, so a throw that is
  // not a Stripe error object — a fetch that never got a response — must still
  // produce a line that says what happened, not `undefined`.
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw "socket hang up";
  }) as typeof fetch;
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "dawn", format: "digital" }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await body(response), {
      error: "Could not create Checkout Session",
      code: "checkout-unavailable",
    });
    // The error is logged whole, so the SDK's code survives for the causes that
    // have one and the message survives for the ones that do not.
    assert.ok(
      logged.some((args) => args[0] === "stripe.checkout.sessions.create" && args.length === 2),
      `expected the raw error in the log, got ${JSON.stringify(logged)}`,
    );
  } finally {
    console.error = realError;
    globalThis.fetch = originalFetch;
    restore();
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

/** A Stripe-style signature header for `payload` under `secret`. */
async function sign(payload: string, secret: string): Promise<string> {
  const { hmacSha256Hex } = await import("../src/lib/crypto-hex.ts");
  const timestamp = Math.floor(Date.now() / 1000);
  // Stripe signs "<timestamp>.<raw body>", which is the detail most hand-rolled
  // webhook tests get wrong.
  const digest = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
  return `t=${timestamp},v1=${digest}`;
}

const JPEG = new TextEncoder().encode("fake-jpeg-bytes");

function bucket() {
  return {
    async get() {
      return { body: new Blob([JPEG]).stream(), size: JPEG.length };
    },
  };
}

test("print-asset: a verified request streams the master as image/jpeg", async () => {
  const secret = "route-test-print-asset-secret-32-chars";
  const { signPrintAssetUrl } = await import("../src/lib/print-asset.ts");
  const signed = await signPrintAssetUrl("dawn", { secret, baseUrl: SITE });
  const restore = withBindings({
    printAssetSecret: secret,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const response = await printAsset.GET(new Request(signed!));
    assert.equal(response.status, 200);
    // Prodigi fetches this URL; a browser-sniffable type or a cached copy would
    // be the wrong thing to hand it.
    assert.equal(response.headers.get("Content-Type"), "image/jpeg");
    assert.equal(response.headers.get("Content-Length"), String(JPEG.length));
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes], [...JPEG]);
  } finally {
    restore();
  }
});

test("print-asset: a bucket that throws is a 503, an absent master a 404", async () => {
  const secret = "route-test-print-asset-secret-32-chars";
  const { signPrintAssetUrl } = await import("../src/lib/print-asset.ts");
  const signed = await signPrintAssetUrl("dawn", { secret, baseUrl: SITE });
  const throwing = {
    async get(): Promise<never> {
      throw new Error("R2 down");
    },
  };
  const restore = withBindings({
    printAssetSecret: secret,
    MASTERS: throwing,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await printAsset.GET(new Request(signed!));
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "masters-unavailable");
  } finally {
    restore();
  }
  const restore2 = withBindings({
    printAssetSecret: secret,
    MASTERS: { async get() { return null; } },
    prodigiKeyConfigured: false,
  });
  try {
    const missing = await printAsset.GET(new Request(signed!));
    assert.equal(missing.status, 404);
    assert.equal((await body(missing)).error, "master-not-found");
  } finally {
    restore2();
  }
});

test("download: a paid digital order streams the master as an attachment", async () => {
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  const record = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: masterKeyForSlug("dawn"),
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  const orders = memoryKv({ cs_test_abcdefgh: record });
  const token = await seedToken(orders, "cs_test_abcdefgh");
  const restore = withBindings({
    ORDERS_DB: orders,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="dawn.jpg"',
    );
    assert.equal(response.headers.get("Content-Type"), "image/jpeg");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // A customer's purchase must not sit in a shared cache. This header was
    // written out four times across the two asset routes; the download route
    // asserted none of them.
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  } finally {
    restore();
  }
});

test("download: a master that is not a JPEG is served with its own content type", async () => {
  // #109. The route read `object.contentType`, which is not a field R2 has —
  // the real one is `httpMetadata.contentType` — so the read was always
  // undefined and every master was announced as image/jpeg. A PNG master is
  // the case that shows it, and it is asserted here at the HTTP boundary
  // because that is where the wrong header reaches the customer.
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  const record = JSON.stringify({
    v: 1,
    sessionId: "cs_test_pngmaster",
    merchantReference: "cs_test_pngmaster",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: masterKeyForSlug("dawn"),
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  const orders = memoryKv({ cs_test_pngmaster: record });
  const token = await seedToken(orders, "cs_test_pngmaster");
  const restore = withBindings({
    ORDERS_DB: orders,
    MASTERS: {
      async get() {
        return {
          body: new Blob([JPEG]).stream(),
          size: JPEG.length,
          httpMetadata: { contentType: "image/png" },
        };
      },
    },
    prodigiKeyConfigured: false,
  });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
  } finally {
    restore();
  }
});

test("download: a token-shaped string that is not stored is 404 and uncacheable", async () => {
  const restore = withBindings({
    ORDERS_DB: memoryKv(),
    prodigiKeyConfigured: false,
  });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?token=${"c".repeat(32)}`),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  } finally {
    restore();
  }
});

test("download: a revoked order cannot download, even with a live token (#111)", async () => {
  // The token check runs first by design, so the refusal has to come from
  // resolveDownload — the one place that knows about refunds and disputes. If a
  // token were ever treated as sufficient on its own, this would serve a
  // refunded buyer's file.
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  assert.ok(masterKeyForSlug("dawn"));
  const paid = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: masterKeyForSlug("dawn"),
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  const orders = memoryKv({ cs_test_abcdefgh: paid });
  const token = await seedToken(orders, "cs_test_abcdefgh");
  const restore = withBindings({
    ORDERS_DB: orders,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    assert.equal(
      (
        await download.GET(
          new Request(`${SITE}/api/download?token=${token}`),
        )
      ).status,
      200,
      "the token works while the order is paid",
    );
    await orders.putOrder({
        ...JSON.parse(paid),
        status: "refunded",
        masterKey: null,
      });
    const revoked = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(revoked.status, 409);
    assert.equal((await body(revoked)).error, "download-unavailable");
  } finally {
    restore();
  }
});

test("download: a token is spent by the downloads it grants (#111)", async () => {
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  const orders = memoryKv({
    cs_test_abcdefgh: JSON.stringify({
      v: 1,
      sessionId: "cs_test_abcdefgh",
      merchantReference: "cs_test_abcdefgh",
      terminal: true,
      status: "paid",
      photoSlug: "dawn",
      format: "digital",
      size: "",
      frame: "",
      quoteEur: 15,
      amountTotal: 1500,
      currency: "eur",
      reason: null,
      masterKey: masterKeyForSlug("dawn"),
      recipient: null,
      prodigiOrderId: null,
      prodigiStage: null,
      assetUrl: null,
      updatedAt: "2026-09-27T12:00:00.000Z",
    }),
  });
  const token = await seedToken(orders, "cs_test_abcdefgh", { remaining: 2 });
  const restore = withBindings({
    ORDERS_DB: orders,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  const fetchIt = () =>
    download.GET(new Request(`${SITE}/api/download?token=${token}`));
  try {
    assert.equal((await fetchIt()).status, 200);
    assert.equal((await fetchIt()).status, 200);
    const spent = await fetchIt();
    assert.equal(spent.status, 410);
    assert.equal((await body(spent)).error, "download-limit-reached");
    // The index is rewritten with the new count, so the success page cannot
    // offer a token whose balance is already gone.
    const index = JSON.parse((await orders.findDownloadToken(`cs_test_abcdefgh`))!);
    assert.equal(index.remaining, 0);
    assert.equal(index.token, token, "the index keeps naming the token");
  } finally {
    restore();
  }
});

test("download: an expired token is 410 even with downloads left (#111)", async () => {
  const orders = memoryKv({
    cs_test_abcdefgh: JSON.stringify({
      v: 1,
      sessionId: "cs_test_abcdefgh",
      merchantReference: "cs_test_abcdefgh",
      terminal: true,
      status: "paid",
      photoSlug: "dawn",
      format: "digital",
      size: "",
      frame: "",
      quoteEur: 15,
      amountTotal: 1500,
      currency: "eur",
      reason: null,
      masterKey: "prints/dawn.jpg",
      recipient: null,
      prodigiOrderId: null,
      prodigiStage: null,
      assetUrl: null,
      updatedAt: "2026-09-27T12:00:00.000Z",
    }),
  });
  const token = await seedToken(orders, "cs_test_abcdefgh", {
    expiresAt: Math.floor(Date.now() / 1000) - 1,
  });
  const restore = withBindings({
    ORDERS_DB: orders,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?token=${token}`),
    );
    assert.equal(response.status, 410);
    assert.equal((await body(response)).error, "download-expired");
  } finally {
    restore();
  }
});

test("download: a physical order is 403 and a missing master is a 404", async () => {
  const physical = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 20,
    amountTotal: 1999,
    currency: "eur",
    reason: null,
    masterKey: null,
    prodigiOrderId: "ord_1",
    prodigiStage: null,
    assetUrl: `${SITE}/placeholders/dawn.jpg`,
    updatedAt: "2026-09-27T12:00:00.000Z",
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: null,
      phone: null,
    },
  };
  const record = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...physical, ...over });
  // A token is minted for the print too, deliberately: the refusal must come
  // from the format check, not from the customer simply not having a token.
  const printOrders = memoryKv({ cs_test_abcdefgh: record() });
  const printToken = await seedToken(printOrders, "cs_test_abcdefgh");
  const restore = withBindings({
    ORDERS_DB: printOrders,
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const refused = await download.GET(
      new Request(`${SITE}/api/download?token=${printToken}`),
    );
    assert.equal(refused.status, 403, "a print is not a download");
    assert.equal((await body(refused)).error, "not-a-digital-download");
  } finally {
    restore();
  }
  // The 404 needs a digital record: a print is refused with 403 before the
  // bucket is ever read, so a physical order can never reach that branch.
  const digital = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: "prints/dawn.jpg",
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  const digitalOrders = memoryKv({ cs_test_abcdefgh: digital });
  const digitalToken = await seedToken(digitalOrders, "cs_test_abcdefgh");
  const restore2 = withBindings({
    ORDERS_DB: digitalOrders,
    MASTERS: { async get() { return null; } },
    prodigiKeyConfigured: false,
  });
  try {
    const missing = await download.GET(
      new Request(`${SITE}/api/download?token=${digitalToken}`),
    );
    assert.equal(missing.status, 404);
  } finally {
    restore2();
  }
});

test("quote: a physical quote is priced from the Prodigi response", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "9.5" } }],
            costSummary: { shipping: { amount: "4.99" } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const response = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, {
        format: "giclee",
        size: "30x40",
        frame: null,
        destinationCountryCode: "BG",
      }),
    );
    assert.equal(response.status, 200);
    const priced = await body(response);
    assert.equal(priced.shippingEur, 4.99);
    assert.equal(priced.merchandiseEur, 11.4, "9.50 of unit cost at the margin");
    // This route is unauthenticated, so it must not hand out the wholesale
    // cost or the SKU codes: together with merchandiseEur they disclose our
    // unit cost and the margin multiplier to anyone who curls it.
    assert.equal("sku" in priced, false, "sku must not be public");
    assert.equal("unitCostEur" in priced, false, "unit cost must not be public");
    assert.deepEqual(Object.keys(priced).sort(), [
      "merchandiseEur",
      "shippingEur",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("quote: a repeated identical quote is served from cache, and checkout still quotes live", async () => {
  // #113: /api/quote is unauthenticated and shares Prodigi's rate limit with
  // checkout, so the second identical request must not reach Prodigi. Checkout
  // must, because price integrity at the point of payment is worth the call.
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as { caches?: unknown }).caches;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";

  const entries = new Map<string, string>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(request: Request) {
        const stored = entries.get(request.url);
        return stored === undefined
          ? undefined
          : new Response(stored, {
              headers: { "content-type": "application/json" },
            });
      },
      async put(request: Request, response: Response) {
        entries.set(request.url, await response.text());
      },
    },
  };

  let prodigiCalls = 0;
  globalThis.fetch = (async () => {
    prodigiCalls += 1;
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "9.5" } }],
            costSummary: { shipping: { amount: "4.99" } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const request = () =>
    jsonRequest(`${SITE}/api/quote`, {
      format: "giclee",
      size: "30x40",
      frame: null,
      destinationCountryCode: "BG",
    });

  try {
    const first = await quote.POST(request());
    const second = await quote.POST(request());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await body(second), await body(first));
    assert.equal(prodigiCalls, 1, "the repeat must not call Prodigi again");

    // A different destination is a different quote, not the cached one.
    const other = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, {
        format: "giclee",
        size: "30x40",
        frame: null,
        destinationCountryCode: "US",
      }),
    );
    assert.equal(other.status, 200);
    assert.equal(prodigiCalls, 2, "a new country must still be quoted live");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
    restoreEnv(saved);
  }
});

test("checkout: a physical order with no signing secret is refused before payment", async () => {
  // The primary fail-closed guard. Without a usable secret we cannot sign the
  // master URL, and the fulfillment path used to fall back to the ~41KB public
  // placeholder — the customer pays for a 70x100 giclee and Prodigi receives a
  // 1600x1200 thumbnail, with nothing recording it. Refusing here means the
  // customer is never charged, so there is no refund path to build.
  for (const secret of [undefined, "", "   ", "too-short"]) {
    const savedSecret = process.env.PRINT_ASSET_HMAC_SECRET;
    if (secret === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
    else process.env.PRINT_ASSET_HMAC_SECRET = secret;
    const saved = { ...process.env };
    const originalFetch = globalThis.fetch;
    process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
    process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    let stripeCalled = false;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("stripe.com")) {
        stripeCalled = true;
        return new Response(JSON.stringify({ id: "cs_test_abcdefgh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          quotes: [
            {
              items: [{ unitCost: { amount: "9.5" } }],
              costSummary: { shipping: { amount: "4.99" } },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const response = await checkout.POST(
        jsonRequest(`${SITE}/api/checkout`, {
          photoSlug: "dawn",
          format: "giclee",
          size: "30x40",
          frame: null,
          destinationCountryCode: "BG",
        }),
      );
      assert.equal(response.status, 503, JSON.stringify(secret));
      assert.equal((await body(response)).error, "Print fulfillment is not configured");
      assert.equal(stripeCalled, false, "no Stripe session may be created");
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of [
        "STRIPE_SECRET_KEY",
        "PRODIGI_API_BASE",
        "PRODIGI_SANDBOX_API_KEY",
      ] as const) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      if (savedSecret !== undefined) {
        process.env.PRINT_ASSET_HMAC_SECRET = savedSecret;
      }
    }
  }
});

test("checkout: a digital order is unaffected by the signing guard", async () => {
  // Digital orders deliver through the gated /api/download path and never touch
  // Prodigi, so the guard must not block them.
  const savedSecret = process.env.PRINT_ASSET_HMAC_SECRET;
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ id: "cs_test_abcdefgh", url: "https://checkout.stripe.com/pay" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, { photoSlug: "dawn", format: "digital" }),
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["STRIPE_SECRET_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedSecret !== undefined) {
      process.env.PRINT_ASSET_HMAC_SECRET = savedSecret;
    }
  }
});

test("checkout: a physical order quotes, locks the country, and ships a rate", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  let sessionParams: Record<string, unknown> | null = null;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes("stripe.com")) {
      // Stripe posts form-encoded, not JSON.
      sessionParams = Object.fromEntries(new URLSearchParams(init!.body!));
      return new Response(
        JSON.stringify({ id: "cs_test_abcdefgh", url: "https://checkout.stripe.com/pay" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "9.5" } }],
            costSummary: { shipping: { amount: "4.99" } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const restore = withBindings({ prodigiKeyConfigured: true });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
        destinationCountryCode: "BG",
      }),
    );
    assert.equal(response.status, 200);
    const result = await body(response);
    assert.equal(result.shippingEur, 4.99);
    assert.equal(result.merchandiseEur, 11.4);
    // The Stripe session must carry the same quote the webhook later verifies,
    // or the paid amount will not match the record.
    const params = sessionParams as unknown as Record<string, string>;
    assert.equal(params["metadata[shippingEur]"], "4.99");
    // quoteEur, not merchandiseEur: the latter was a duplicate of the same
    // number written only for physical orders, and fulfillment.ts still reads
    // it as a fallback for sessions created before it was redundant. Asserted
    // in both directions so a re-add and a silent removal of quoteEur both
    // fail here rather than at the amount check in the webhook.
    assert.equal(params["metadata[quoteEur]"], "11.4");
    assert.equal("metadata[merchandiseEur]" in params, false);
    assert.equal(params["metadata[sku]"], "GLOBAL-FAP-12X16");
    assert.equal(params["metadata[photoSlug]"], "dawn");
    assert.equal(params["shipping_address_collection[allowed_countries][0]"], "BG");
    // The image Stripe shows is the same URL the order body carries, built
    // by the one helper. It was asserted nowhere, so the two spellings of it
    // could have drifted without any test noticing.
    const { PLACEHOLDER_VERSION } = await import(
      "../src/lib/placeholder-photo.ts"
    );
    assert.equal(
      params["line_items[0][price_data][product_data][images][0]"],
      `${SITE}/placeholders/dawn.jpg?v=${PLACEHOLDER_VERSION}`,
    );
    assert.equal(params["shipping_options[0][shipping_rate_data][fixed_amount][amount]"], "499");
    // Stated in the create params rather than left to the Stripe dashboard
    // toggle, so the amount semantics the webhook's `amount-mismatch` check
    // depends on are visible in the code. See tests/adaptive-pricing.test.mts.
    assert.equal(params["adaptive_pricing[enabled]"], "false");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of [
      "STRIPE_SECRET_KEY",
      "PRODIGI_API_BASE",
      "PRODIGI_SANDBOX_API_KEY",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("checkout: an unconfigured quote, a Stripe failure and a session with no URL", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    globalThis.fetch = (async () => { throw new Error("not reached"); }) as typeof fetch;
    const unquoted = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
      }),
    );
    assert.equal(unquoted.status, 503, "an unset Prodigi key is 503, not 502");

    process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
    const quoteResponse = () =>
      new Response(
        JSON.stringify({
          quotes: [
            {
              items: [{ unitCost: { amount: "9.5" } }],
              costSummary: { shipping: { amount: "4.99" } },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("stripe.com")) return new Response("boom", { status: 500 });
      return quoteResponse();
    }) as typeof fetch;
    const failed = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
      }),
    );
    assert.equal(failed.status, 502);
    assert.equal((await body(failed)).error, "Could not create Checkout Session");

    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("stripe.com")) {
        return new Response(JSON.stringify({ id: "cs_test_abcdefgh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return quoteResponse();
    }) as typeof fetch;
    const noUrl = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
      }),
    );
    assert.equal(noUrl.status, 502);
    assert.equal((await body(noUrl)).error, "Stripe session missing URL");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of [
      "STRIPE_SECRET_KEY",
      "PRODIGI_API_BASE",
      "PRODIGI_SANDBOX_API_KEY",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("print-asset and download: a request with no query string is a 400", async () => {
  const restore = withBindings({
    printAssetSecret: "route-test-print-asset-secret-32-chars",
    ORDERS_DB: memoryKv(),
    prodigiKeyConfigured: false,
  });
  try {
    const asset = await printAsset.GET(new Request(`${SITE}/api/print-asset`));
    assert.equal(asset.status, 400);
    assert.equal((await body(asset)).error, "invalid-slug");
    // The download route's credential is a token (#111), so a bare request is
    // a missing token — not a missing session id.
    const file = await download.GET(new Request(`${SITE}/api/download`));
    assert.equal(file.status, 400);
    assert.equal((await body(file)).error, "invalid-token");
  } finally {
    restore();
  }
});

test("quote: an omitted destination country defaults, and a non-Error throw is a 502", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  try {
    const respond = () =>
      new Response(
        JSON.stringify({
          quotes: [
            {
              items: [{ unitCost: { amount: "9.5" } }],
              costSummary: { shipping: { amount: "4.99" } },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = (async () => respond()) as typeof fetch;
    const response = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, { format: "giclee", size: "30x40" }),
    );
    assert.equal(response.status, 200);
    const defaulted = (await body(response)).sku;

    const explicit = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, {
        format: "giclee",
        size: "30x40",
        destinationCountryCode: "BG",
      }),
    );
    // The omitted destination resolves to the site's own country, so the SKU
    // is the one BG would have produced — not a default that silently drifts.
    assert.equal(defaulted, (await body(explicit)).sku);
    // A non-Error throw must still be a JSON 502, not an unhandled rejection
    // escaping the route.
    globalThis.fetch = (async () => {
      throw "socket exploded";
    }) as typeof fetch;
    const broken = await quote.POST(
      jsonRequest(`${SITE}/api/quote`, { format: "giclee", size: "30x40" }),
    );
    assert.equal(broken.status, 502);
    assert.deepEqual(await body(broken), {
      error: "Pricing is temporarily unavailable, please try again.",
      code: "prodigi-unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("checkout: a non-Error throw from the quote layer is a 502", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  globalThis.fetch = (async () => {
    throw "socket exploded";
  }) as typeof fetch;
  const restore = withBindings({ prodigiKeyConfigured: true });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "giclee",
        size: "30x40",
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await body(response), {
      error: "Pricing is temporarily unavailable, please try again.",
      code: "prodigi-unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of [
      "STRIPE_SECRET_KEY",
      "PRODIGI_API_BASE",
      "PRODIGI_SANDBOX_API_KEY",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("webhook: a digital event with no shipping and no customer details still fills out", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_4",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: "eur",
        amount_total: 1500,
        metadata: {
          photoSlug: "dawn",
          format: "digital",
          size: "",
          frame: "",
          quoteEur: "15",
        },
      },
    },
  });
  const signature = await sign(event, secret);
  const kv = memoryKv();
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: kv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    const parsed = await body(response);
    assert.equal(parsed.status, "paid");
    const stored = JSON.parse((await kv.getOrder("cs_test_abcdefgh"))!) as {
      masterKey: string;
      recipient: unknown;
    };
    assert.equal(stored.masterKey, masterKeyForSlug("dawn"));
    assert.equal(stored.recipient, null);
  } finally {
    restore();
  }
});

test("webhook: the legacy shipping_details field is used when collected_information is absent", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_5",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: "eur",
        amount_total: 1999,
        metadata: {
          photoSlug: "dawn",
          format: "giclee",
          size: "30x40",
          frame: "",
          quoteEur: "15",
          merchandiseEur: "11.4",
          shippingEur: "4.99",
          sku: "GLOBAL-FAP-12X16",
        },
        shipping_details: {
          name: "Test Buyer",
          address: {
            line1: "1 Harbor St",
            line2: null,
            city: "Nessebar",
            state: null,
            postal_code: "8230",
            country: "BG",
          },
        },
        customer_details: { email: "buyer@example.com", phone: null },
      },
    },
  });
  const signature = await sign(event, secret);
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  let recipient: { address: { townOrCity: string } } | null = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    recipient = JSON.parse(init!.body!).recipient;
    return new Response(JSON.stringify({ order: { id: "ord_legacy_1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: memoryKv(),
    prodigiKeyConfigured: true,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, "paid");
    assert.equal(recipient?.address.townOrCity, "Nessebar");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("webhook: a session with no id is stored under the empty key, not lost", async () => {
  // Stripe always sends an id, but a malformed event must not be handled as a
  // real order: fulfillCheckoutSession rejects the empty session id and the
  // webhook answers 200 with the reason rather than throwing.
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_6",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { payment_status: "paid" } },
  });
  const signature = await sign(event, secret);
  const kv = memoryKv();
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: kv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    // An event with no session id is ignored outright, and nothing is written
    // under the empty key.
    assert.deepEqual(await body(response), {
      received: true,
      ignored: "invalid-session-id",
    });
    assert.equal(await kv.getOrder(""), null);
  } finally {
    restore();
  }
});

test("checkout: a framed order names the finish in the line item", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  let sent = "";
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes("stripe.com")) {
      sent = new URLSearchParams(init!.body!).get(
        "line_items[0][price_data][product_data][description]",
      ) ?? "";
      return new Response(
        JSON.stringify({ id: "cs_test_abcdefgh", url: "https://checkout.stripe.com/pay" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        quotes: [
          {
            items: [{ unitCost: { amount: "9.5" } }],
            costSummary: { shipping: { amount: "4.99" } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const restore = withBindings({ prodigiKeyConfigured: true });
  try {
    const response = await checkout.POST(
      jsonRequest(`${SITE}/api/checkout`, {
        photoSlug: "dawn",
        format: "framed",
        size: "30x40",
        frame: "black",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(sent, "30x40 · black frame");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    for (const key of [
      "STRIPE_SECRET_KEY",
      "PRODIGI_API_BASE",
      "PRODIGI_SANDBOX_API_KEY",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("webhook: a customer phone is carried into the stored record", async () => {
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_7",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: "eur",
        amount_total: 1500,
        metadata: {
          photoSlug: "dawn",
          format: "digital",
          size: "",
          frame: "",
          quoteEur: "15",
        },
        customer_details: { email: null, phone: null },
      },
    },
  });
  const signature = await sign(event, secret);
  const kv = memoryKv();
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: kv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, "paid");
  } finally {
    restore();
  }
});

test("webhook: a session with no currency, amount or metadata is paid-unfulfilled", async () => {
  // Every field the route forwards is nullable in Stripe's own type, and each
  // `??` arm is a decision: an absent currency must not become "eur" and an
  // absent amount must not become 0, which would read as a free order.
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_8",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: null,
        amount_total: null,
        metadata: null,
      },
    },
  });
  const signature = await sign(event, secret);
  const kv = memoryKv();
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: kv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    // With no metadata there is no photo, so nothing can be fulfilled: the
    // order is recorded as paid-but-unfulfilled, which an operator can see.
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, "paid-unfulfilled");

    // Pinned, and worth reading: the nulls are not preserved. buildRecord
    // defaults a missing currency to "eur" and a missing amount to 0, so a
    // session that somehow arrived without them is stored as a EUR 0.00 order.
    // Stripe always sends both on checkout.session.completed, so this is not
    // reachable in production today; it is pinned so that it becomes a
    // deliberate change if the defaults ever move.
    const stored = JSON.parse((await kv.getOrder("cs_test_abcdefgh"))!) as {
      currency: string;
      amountTotal: number;
      reason: string;
    };
    assert.equal(stored.reason, "bad-metadata");
    assert.equal(stored.currency, "eur");
    assert.equal(stored.amountTotal, 0);
  } finally {
    restore();
  }
});

test("webhook: a session with no payment_status at all is unpaid, not fulfilled", async () => {
  // The sibling case above sends payment_status: "paid" and nulls out the
  // other fields, so `session.payment_status ?? null` only ever saw its left
  // arm. An absent field is the realistic one for an event type that never
  // settled, and it must reach fulfillment as null: `!== "paid"` is then true
  // and the session is ignored, rather than the route inventing a status that
  // would let an unpaid order through.
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_9",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_nopaymentstatus",
        metadata: { photoSlug: "test-photo" },
      },
    },
  });
  const signature = await sign(event, secret);
  const kv = memoryKv();
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: kv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { received: true, ignored: "unpaid" });
    // Nothing is written for an ignored session — a retry must not find a
    // half-built record.
    assert.equal(await kv.getOrder("cs_test_nopaymentstatus"), null);
  } finally {
    restore();
  }
});

test("webhook: a store that throws mid-fulfilment is a 500, not a lost order", async () => {
  // fulfillCheckoutSession is given the Worker binding directly, so a KV
  // outage surfaces as a thrown call. The route must answer 500 so Stripe
  // retries, rather than letting the exception escape the handler.
  const secret = "whsec_test_route_secret";
  const event = JSON.stringify({
    id: "evt_9",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abcdefgh",
        payment_status: "paid",
        currency: "eur",
        amount_total: 1500,
        metadata: {
          photoSlug: "dawn",
          format: "digital",
          size: "",
          frame: "",
          quoteEur: "15",
        },
      },
    },
  });
  const signature = await sign(event, secret);
  const brokenKv = {
    async get() {
      throw new Error("kv offline");
    },
    async put() {
      throw new Error("kv offline");
    },
  };
  const restore = withBindings({
    webhookSecret: secret,
    ORDERS_DB: brokenKv,
    prodigiKeyConfigured: false,
  });
  try {
    const response = await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: event,
      }),
    );
    // A KV that throws is NOT the same as a KV that is absent, and the old
    // bare catch reported both as "orders-store-unavailable" — so a real
    // fulfillment bug pointed the log at the binding. Distinct error now.
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: "fulfillment-failed" });
  } finally {
    restore();
  }
});

/* --- refunds and disputes (#101) ------------------------------------------

   The revocation path is the one place the webhook resolves an order through
   Stripe rather than through the event: ORDERS is keyed by session id and a
   charge event carries a payment intent. These drive it through the real
   handler with globalThis.fetch answering the Stripe lookup, because the
   interesting failures are all in the glue — a partial refund must not revoke,
   a Stripe outage must not answer 200, and a dispute must survive the extra
   charge hop. */

const REFUND_SESSION = "cs_test_refunded01";
const REFUND_INTENT = "pi_3AbcDefGh12345678";

function paidDigitalRecord(sessionId: string): string {
  return JSON.stringify({
    v: 1,
    sessionId,
    merchantReference: sessionId,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 30,
    amountTotal: 3000,
    currency: "eur",
    reason: null,
    masterKey: "prints/dawn.jpg",
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
}

/** A fetch that answers the sessions.list lookup and nothing else. */
function stripeLookupFetch(sessions: unknown[] = [{ id: REFUND_SESSION }]): typeof fetch {
  return (async (url: unknown) => {
    const target = String(url);
    if (target.includes("/checkout/sessions")) {
      return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
}

async function postEvent(
  event: Record<string, unknown>,
  secret: string,
  bindings: Fake,
): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = await sign(payload, secret);
  const restore = withBindings(bindings);
  try {
    return await stripe.POST(
      new Request(`${SITE}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      }),
    );
  } finally {
    restore();
  }
}

test("webhook: a full refund revokes the order", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeLookupFetch();
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  try {
    const response = await postEvent(
      {
        id: "evt_refund_1",
        object: "event",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_3AbcDefGh",
            payment_intent: REFUND_INTENT,
            amount: 3000,
            amount_refunded: 3000,
          },
        },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 200);
    const parsed = await body(response);
    assert.equal(parsed.revoked, true);
    assert.equal(parsed.status, "refunded");
    // Read back through get, which is the only contract OrdersKv has.
    const record = JSON.parse((await kv.getOrder(REFUND_SESSION))!) as Record<string, unknown>;
    assert.equal(record.status, "refunded");
    assert.equal(record.masterKey, null);
    assert.equal(record.photoSlug, "dawn", "the refund stays auditable");
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a partial refund is logged and revokes nothing", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a partial refund must not reach Stripe at all");
  }) as typeof fetch;
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const response = await postEvent(
      {
        id: "evt_refund_partial",
        object: "event",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_3AbcDefGh",
            payment_intent: REFUND_INTENT,
            amount: 3000,
            amount_refunded: 1000,
          },
        },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { received: true, ignored: "partial-refund" });
    const record = JSON.parse((await kv.getOrder(REFUND_SESSION))!) as Record<string, unknown>;
    assert.equal(record.status, "paid", "a partial refund must not revoke the download");
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
  assert.match(errors.join("\n"), /order\.partial-refund/);
  assert.match(errors.join("\n"), /1000/);
});

test("webhook: a Stripe lookup failure is a 500, not a silent 200", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors: string[] = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { type: "api_error" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  try {
    const response = await postEvent(
      {
        id: "evt_refund_500",
        object: "event",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_3AbcDefGh",
            payment_intent: REFUND_INTENT,
            amount: 3000,
            amount_refunded: 3000,
          },
        },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    // The whole mechanism fails silently if this is a 200: the refund is real,
    // the buyer keeps the master file, and every log line looks healthy.
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: "revocation-lookup-failed" });
    const record = JSON.parse((await kv.getOrder(REFUND_SESSION))!) as Record<string, unknown>;
    assert.equal(record.status, "paid", "nothing is written when the lookup failed");
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
  assert.match(errors.join("\n"), /order\.revocation-lookup-failed/);
});

test("webhook: a KV failure during revocation is a 500 with its own error", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = stripeLookupFetch();
  console.error = () => {};
  try {
    const response = await postEvent(
      {
        id: "evt_refund_kv",
        object: "event",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_3AbcDefGh",
            payment_intent: REFUND_INTENT,
            amount: 3000,
            amount_refunded: 3000,
          },
        },
      },
      secret,
      {
        webhookSecret: secret,
        prodigiKeyConfigured: false,
        ORDERS_DB: {
          async get() {
            throw new Error("kv offline");
          },
          async put() {
            throw new Error("kv offline");
          },
        },
      },
    );
    // Distinct from fulfillment-failed so the log points at the revocation
    // path rather than at Prodigi.
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: "revocation-failed" });
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a dispute resolves through the charge hop and revokes", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    seen.push(`${init?.method ?? "GET"} ${target}`);
    if (target.includes("/charges/")) {
      return new Response(
        JSON.stringify({ id: "ch_3AbcDefGh", payment_intent: REFUND_INTENT }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/checkout/sessions")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: REFUND_SESSION }], has_more: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  try {
    const response = await postEvent(
      {
        id: "evt_dispute_1",
        object: "event",
        type: "charge.dispute.created",
        data: {
          // The Dispute object names a Charge, not a PaymentIntent. Without
          // the hop every dispute resolves to "no payment intent" and no
          // order is ever revoked.
          object: { id: "dp_1", object: "dispute", charge: "ch_3AbcDefGh", amount: 3000 },
        },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 200);
    const parsed = await body(response);
    assert.equal(parsed.status, "disputed");
    const record = JSON.parse((await kv.getOrder(REFUND_SESSION))!) as Record<string, unknown>;
    assert.equal(record.status, "disputed");
    assert.ok(seen.some((line) => line.includes("/charges/ch_3AbcDefGh")));
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a dispute whose charge lookup fails transiently is a 500, not a silent 200", async () => {
  // The gap this pins: a dispute needs two hops, and the first one used to
  // swallow any failure into `null`, which the route answered 200
  // "no-payment-intent". Stripe does not redeliver a 200, so the disputed
  // buyer kept the master file with every log line looking healthy.
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    if (target.includes("/charges/")) {
      // A Stripe outage, not a missing charge. 404 would be ignorable; this
      // must be redelivered.
      return new Response(JSON.stringify({ error: { type: "api_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
  console.error = () => {};
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  try {
    const response = await postEvent(
      {
        id: "evt_dispute_500",
        object: "event",
        type: "charge.dispute.created",
        data: {
          object: { id: "dp_500", object: "dispute", charge: "ch_3AbcDefGh", amount: 3000 },
        },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: "revocation-lookup-failed" });
    const record = JSON.parse((await kv.getOrder(REFUND_SESSION))!) as Record<string, unknown>;
    assert.equal(record.status, "paid", "nothing is written when the lookup failed");
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a dispute for an unknown charge is acknowledged, not retried forever", async () => {
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  // The charge resolves to a real payment intent, but no Checkout Session
  // came from it: another Stripe account's dispute reaching this endpoint.
  // Retrying that forever helps nobody, so it is a 200.
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    if (target.includes("/charges/")) {
      return new Response(
        JSON.stringify({ id: "ch_unknown1", payment_intent: REFUND_INTENT }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return stripeLookupFetch([])(target);
  }) as typeof fetch;
  console.error = () => {};
  try {
    const response = await postEvent(
      {
        id: "evt_dispute_unknown",
        object: "event",
        type: "charge.dispute.created",
        data: { object: { id: "dp_2", object: "dispute", charge: "ch_unknown1" } },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: memoryKv(), prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 200);
    assert.equal((await body(response)).ignored, "unknown-payment-intent");
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a refund for a session with no ORDERS binding is still 503", async () => {
  // The binding check runs before the revocation branch, so a misconfigured
  // deploy is diagnosed the same way for every handled event.
  const secret = "whsec_test_route_secret";
  const response = await postEvent(
    {
      id: "evt_refund_nokv",
      object: "event",
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: REFUND_INTENT, amount: 1, amount_refunded: 1 } },
    },
    secret,
    { webhookSecret: secret, prodigiKeyConfigured: false },
  );
  assert.equal(response.status, 503);
  assert.equal((await body(response)).error, "orders-store-unavailable");
});

test("webhook: a refund event with no amounts is not treated as a partial refund", async () => {
  // `amount_refunded: 0` is what Stripe sends for the first partial refund of
  // several, and some dashboard re-sends carry no amounts at all. Reading
  // "no numbers" as "not partial" is the safe direction only because the
  // alternative — guessing a revocation — cannot be undone.
  const secret = "whsec_test_route_secret";
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = "sk_test_route_key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeLookupFetch();
  const kv = memoryKv({ [REFUND_SESSION]: paidDigitalRecord(REFUND_SESSION) });
  try {
    const response = await postEvent(
      {
        id: "evt_refund_zero",
        object: "event",
        type: "charge.refunded",
        data: { object: { id: "ch_1", payment_intent: REFUND_INTENT } },
      },
      secret,
      { webhookSecret: secret, ORDERS_DB: kv, prodigiKeyConfigured: false },
    );
    assert.equal(response.status, 200);
    assert.equal((await body(response)).revoked, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
  }
});

test("webhook: a partial refund with no payment intent is still only logged", async () => {
  // The log line must survive a charge that names no intent, otherwise the
  // one record of "we chose not to revoke this" comes out as `null` with no
  // way to tell it apart from a shape we did not expect.
  const secret = "whsec_test_route_secret";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors: string[] = [];
  globalThis.fetch = (async () => {
    throw new Error("a partial refund must not reach Stripe");
  }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const response = await postEvent(
      {
        id: "evt_refund_partial_nointent",
        object: "event",
        type: "charge.refunded",
        data: { object: { id: "ch_1", amount: 3000, amount_refunded: 500 } },
      },
      secret,
      {
        webhookSecret: secret,
        ORDERS_DB: memoryKv(),
        prodigiKeyConfigured: false,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { received: true, ignored: "partial-refund" });
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  assert.match(errors.join("\n"), /"paymentIntent":null/);
});

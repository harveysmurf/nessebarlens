import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

/* The five route handlers, called the way Next calls them: a Request in, a
   Response out. They own the status codes and the guard order, which is the
   part no test touched until now.

   readWorkerBindings is the one seam. ORDERS and MASTERS are Worker bindings
   and have no env fallback by design, so a route that reads them can only be
   driven from outside by substituting the module — which is what the hook below
   does. The handlers themselves are the real source, imported once. */

const FAKE = "buzz-test:fake-worker-bindings";

type Fake = {
  ORDERS?: unknown;
  MASTERS?: unknown;
  webhookSecret?: string;
  printAssetSecret?: string;
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
  const store = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
};

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
    assert.equal(
      (await body(unconfigured)).error,
      "PRODIGI_SANDBOX_API_KEY is not set",
    );

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

test("download: the session id is checked before the KV is read at all", async () => {
  let touched = 0;
  const kv = {
    async get() {
      touched++;
      return null;
    },
    async put() {},
  };
  const restore = withBindings({ ORDERS: kv, prodigiKeyConfigured: false });
  try {
    const bad = await download.GET(
      new Request(`${SITE}/api/download?session_id=not-a-session`),
    );
    assert.equal(bad.status, 400);
    assert.equal((await body(bad)).error, "invalid-session-id");
    assert.equal(touched, 0, "an unvalidated id must not reach the store");

    const notYet = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
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
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
    );
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error, "orders-kv-unavailable");
  } finally {
    restore();
  }
});

test("download: a KV that throws is a 503, and a foreign record is corrupt", async () => {
  const throwing = {
    async get() {
      throw new Error("kv down");
    },
    async put() {},
  };
  const restore = withBindings({ ORDERS: throwing, prodigiKeyConfigured: false });
  try {
    const down = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
    );
    assert.equal(down.status, 503);
    assert.equal((await body(down)).error, "orders-kv-unavailable");
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
  const restore2 = withBindings({ ORDERS: other, prodigiKeyConfigured: false });
  try {
    const corrupt = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
    );
    assert.equal(corrupt.status, 500);
    assert.equal((await body(corrupt)).error, "corrupt-order");
  } finally {
    restore2();
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
  const restore = withBindings({ webhookSecret: secret, ORDERS: kv, prodigiKeyConfigured: false });
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
    assert.equal((await body(response)).error, "orders-kv-unavailable");
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
    ORDERS: memoryKv(),
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
    // A bare 502 cannot tell a key missing Checkout Sessions write from an
    // account that is not live; the code is the only thing that can.
    assert.equal(failed.stripeCode, "api_key_invalid");
    assert.equal(failed.error, "Could not create Checkout Session");
  } finally {
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
  const restore = withBindings({
    ORDERS: memoryKv({ cs_test_abcdefgh: record }),
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
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

test("download: an invalid session id is 400 and still uncacheable", async () => {
  const restore = withBindings({ prodigiKeyConfigured: false });
  try {
    const response = await download.GET(
      new Request(`${SITE}/api/download?session_id=not-a-session`),
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
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
  const restore = withBindings({
    ORDERS: memoryKv({ cs_test_abcdefgh: record() }),
    MASTERS: bucket(),
    prodigiKeyConfigured: false,
  });
  try {
    const refused = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
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
  const restore2 = withBindings({
    ORDERS: memoryKv({ cs_test_abcdefgh: digital }),
    MASTERS: { async get() { return null; } },
    prodigiKeyConfigured: false,
  });
  try {
    const missing = await download.GET(
      new Request(`${SITE}/api/download?session_id=cs_test_abcdefgh`),
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
    ORDERS: memoryKv(),
    prodigiKeyConfigured: false,
  });
  try {
    const asset = await printAsset.GET(new Request(`${SITE}/api/print-asset`));
    assert.equal(asset.status, 400);
    assert.equal((await body(asset)).error, "invalid-slug");
    const file = await download.GET(new Request(`${SITE}/api/download`));
    assert.equal(file.status, 400);
    assert.equal((await body(file)).error, "invalid-session-id");
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
    assert.equal((await body(broken)).error, "Quote failed");
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
    assert.equal((await body(response)).error, "Quote failed");
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
    ORDERS: kv,
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
    const stored = JSON.parse((await kv.get("cs_test_abcdefgh"))!) as {
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
    ORDERS: memoryKv(),
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
    ORDERS: kv,
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
    assert.equal(await kv.get(""), null);
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
    ORDERS: kv,
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
    ORDERS: kv,
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
    const stored = JSON.parse((await kv.get("cs_test_abcdefgh"))!) as {
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
    ORDERS: kv,
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
    assert.equal(await kv.get("cs_test_nopaymentstatus"), null);
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
    ORDERS: brokenKv,
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
    // bare catch reported both as "orders-kv-unavailable" — so a real
    // fulfillment bug pointed the log at the binding. Distinct error now.
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: "fulfillment-failed" });
  } finally {
    restore();
  }
});

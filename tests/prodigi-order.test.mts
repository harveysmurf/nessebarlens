import assert from "node:assert/strict";
import test from "node:test";
import { PRODIGI_SHIPPING_METHOD } from "../src/lib/prodigi-config.ts";
import { PHOTOS } from "../src/lib/photos.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
  classifyProdigiStatus,
  createProdigiOrder,
  placeholderAssetUrl,
  resolveOrderAssetUrl,
  type OrderRecipient,
} from "../src/lib/prodigi-order.ts";

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

test("placeholder asset URL is public https under /placeholders", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const url = placeholderAssetUrl("dawn");
  assert.equal(url, "https://nessebarlens.com/placeholders/dawn.jpg");
  assert.match(url, /^https:\/\//);
  assert.equal(url.includes("prints/"), false);
  assert.equal(url.includes("masters"), false);
});

test("Prodigi order body uses SKU + placeholder and never leaks masters", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: "dawn",
    format: "giclee",
    size: "50x70",
    frame: null,
    recipient: RECIPIENT,
  });
  assert.equal(body.idempotencyKey, "cs_test_abcdefgh");
  assert.equal(body.merchantReference, "cs_test_abcdefgh");
  // The value the customer was quoted with, read from the one constant —
  // not re-spelled here, because a test that repeats the literal asserts
  // nothing about whether quote and order agree.
  assert.equal(body.shippingMethod, PRODIGI_SHIPPING_METHOD);
  assert.equal(body.items[0].sku, "GLOBAL-FAP-20X28");
  assert.equal(body.items[0].sizing, "fillPrintArea");
  assert.equal(
    body.items[0].assets[0].url,
    "https://nessebarlens.com/placeholders/dawn.jpg",
  );
  assert.equal(body.recipient.address.countryCode, "BG");
  assert.equal(body.recipient.email, "buyer@example.com");
  assertNoMasterLeak(body);

  for (const photo of PHOTOS) {
    assert.equal(JSON.stringify(body).includes(photo.imageKey), false);
  }
});

test("framed order includes color attribute", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: "dawn",
    format: "framed",
    size: "30x40",
    frame: "brown",
    recipient: RECIPIENT,
  });
  assert.equal(body.items[0].sku, "GLOBAL-CFPM-12X16");
  assert.deepEqual(body.items[0].attributes, { color: "brown" });
});

test("assertNoMasterLeak rejects master keys and masters bucket names", () => {
  assert.throws(() => assertNoMasterLeak({ url: "prints/dawn.jpg" }));
  assert.throws(() =>
    assertNoMasterLeak({ bucket: "nessebar-lens-masters" }),
  );
  assert.doesNotThrow(() =>
    assertNoMasterLeak({
      url: "https://nessebarlens.com/placeholders/dawn.jpg",
    }),
  );
  assert.doesNotThrow(() =>
    assertNoMasterLeak({
      url: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=abc",
    }),
  );
});

/* ------------------------------------------------------------------ */
/* createProdigiOrder: the real fetch path, which until now was only   */
/* ever exercised through the stubbed type in the fulfillment tests.   */
/* ------------------------------------------------------------------ */

const SANDBOX = "https://api.sandbox.prodigi.com";

type FetchCall = { url: string; init: RequestInit };

function withProdigiEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = {
    base: process.env.PRODIGI_API_BASE,
    key: process.env.PRODIGI_SANDBOX_API_KEY,
    site: process.env.NEXT_PUBLIC_SITE_URL,
    secret: process.env.PRINT_ASSET_HMAC_SECRET,
  };
  process.env.PRODIGI_API_BASE = SANDBOX;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  return run().finally(() => {
    for (const [key, value] of [
      ["PRODIGI_API_BASE", saved.base],
      ["PRODIGI_SANDBOX_API_KEY", saved.key],
      ["NEXT_PUBLIC_SITE_URL", saved.site],
      ["PRINT_ASSET_HMAC_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function stubFetch(
  handler: (call: FetchCall) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ORDER_INPUT = {
  sessionId: "cs_test_abcdefgh",
  photoSlug: "dawn",
  format: "giclee" as const,
  size: "50x70" as const,
  frame: null,
  recipient: RECIPIENT,
};

test("createProdigiOrder posts the signed asset URL to the sandbox orders URL", async () => {
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() =>
      json({ order: { id: "ord_123", status: { stage: "awaiting_payment" } } }),
    );
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.orderId, "ord_123");
      assert.equal(result.ok && result.stage, "awaiting_payment");
      assert.equal(stub.calls.length, 1);
      const call = stub.calls[0]!;
      assert.equal(call.url, `${SANDBOX}/v4.0/orders`);
      assert.equal(call.init.method, "POST");
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers["X-API-Key"], "sandbox-key");
      const sent = JSON.parse(call.init.body as string);
      assert.equal(sent.idempotencyKey, "cs_test_abcdefgh");
      assert.equal(sent.merchantReference, "cs_test_abcdefgh");
      // A paid physical order never gets the public placeholder.
      assert.match(sent.items[0].assets[0].url, /\/api\/print-asset\?/);
      assert.equal(result.ok && result.assetUrl, sent.items[0].assets[0].url);
    } finally {
      stub.restore();
    }
  });
});

test("an unsignable master fails the order closed, before any network call", async () => {
  // This is the defect that motivated the guard: without a secret we cannot
  // sign the master, and the old fallback handed Prodigi the ~41KB public
  // placeholder — a customer pays for a 70x100 print and the order is recorded
  // as fulfilled. Retryable, so the webhook answers 5xx and Stripe redelivers.
  for (const secret of [undefined, "too-short", "        "]) {
    await withProdigiEnv(async () => {
      if (secret === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
      else process.env.PRINT_ASSET_HMAC_SECRET = secret;
      const stub = stubFetch(() => json({ order: { id: "ord_never" } }));
      try {
        const result = await createProdigiOrder(ORDER_INPUT);
        assert.equal(result.ok, false, JSON.stringify(secret));
        assert.equal(result.ok === false && result.reason, "prodigi-asset-unconfigured");
        assert.equal(result.ok === false && result.kind, "server");
        assert.equal(stub.calls.length, 0, "Prodigi must never be contacted");
      } finally {
        stub.restore();
      }
    });
  }
});

test("createProdigiOrder signs the asset URL when the HMAC secret is set", async () => {
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() => json({ order: { id: "ord_124" } }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok && result.assetUrl.includes("/api/print-asset?"), true);
      assert.equal(result.ok && result.stage, null, "missing stage becomes null");
    } finally {
      stub.restore();
    }
  });
});

test("auth and rate-limit failures retry; a bad request does not", async () => {
  // Retryability is the load-bearing decision here. A 401 used to be
  // terminal, which meant a wrong sandbox key produced a paid order, a 200 to
  // Stripe, and no redelivery — unrecoverable without manual intervention.
  // Stripe retries for ~3 days, so retrying a genuinely permanent auth failure
  // only buys the window in which to fix the key.
  const cases = [
    [401, "server", "prodigi-auth-error"],
    [403, "server", "prodigi-auth-error"],
    [429, "server", "prodigi-rate-limit"],
    [500, "server", "prodigi-unavailable"],
    [503, "server", "prodigi-unavailable"],
    [400, "client", "prodigi-validation-error"],
    [422, "client", "prodigi-validation-error"],
  ] as const;

  for (const [status, kind, reason] of cases) {
    await withProdigiEnv(async () => {
    // A usable secret, so the fail-closed asset guard does not short-circuit
    // before the HTTP behaviour this test is actually about.
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
      const stub = stubFetch(() => json({ error: "nope" }, status));
      try {
        const result = await createProdigiOrder(ORDER_INPUT);
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.kind, kind, `status ${status}`);
        assert.equal(result.ok === false && result.reason, reason, `status ${status}`);
        assert.equal(result.ok === false && result.status, status);
        assert.equal(
          result.ok === false && result.message,
          `Prodigi order HTTP ${status}`,
        );
      } finally {
        stub.restore();
      }
    });
  }
});

test("auth and rate-limit share retry behaviour but not their reason", async () => {
  // The two axes are separate on purpose: an operator reading the stored
  // record must be able to tell "rotate the key" from "back off".
  assert.notEqual(
    classifyProdigiStatus(401).reason,
    classifyProdigiStatus(429).reason,
  );
  assert.equal(classifyProdigiStatus(401).kind, classifyProdigiStatus(429).kind);
});

test("a 200 with no order id is a client failure, not a silent success", async () => {
  await withProdigiEnv(async () => {
    // A usable secret, so the fail-closed asset guard does not short-circuit
    // before the HTTP behaviour this test is actually about.
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() => json({ order: { status: { stage: "x" } } }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.message, "Prodigi order missing id");
      assert.equal(result.ok === false && result.kind, "client");
    } finally {
      stub.restore();
    }
  });
});

test("a non-JSON 200 body is a failure, not a crash", async () => {
  await withProdigiEnv(async () => {
    // A usable secret, so the fail-closed asset guard does not short-circuit
    // before the HTTP behaviour this test is actually about.
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() => new Response("<html>oops</html>", { status: 200 }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.message, "Prodigi order missing id");
    } finally {
      stub.restore();
    }
  });
});

test("a network throw becomes a server failure with no status", async () => {
  await withProdigiEnv(async () => {
    // A usable secret, so the fail-closed asset guard does not short-circuit
    // before the HTTP behaviour this test is actually about.
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, "server");
      assert.equal(result.ok === false && result.status, null);
      assert.equal(result.ok === false && result.message, "ECONNRESET");
    } finally {
      stub.restore();
    }
  });
});

test("a rejected asset URL never reaches the network", async () => {
  await withProdigiEnv(async () => {
    const stub = stubFetch(() => json({ order: { id: "ord_125" } }));
    try {
      const result = await createProdigiOrder({ ...ORDER_INPUT, assetUrl: "http://insecure.test/a.jpg" });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, "client");
      assert.equal(result.ok === false && result.status, null);
      assert.equal(stub.calls.length, 0, "must not call Prodigi with a bad asset URL");
    } finally {
      stub.restore();
    }
  });
});

test("a master asset URL is a client failure before any network call", async () => {
  await withProdigiEnv(async () => {
    const stub = stubFetch(() => json({ order: { id: "ord_126" } }));
    try {
      const result = await createProdigiOrder({
        ...ORDER_INPUT,
        assetUrl: "https://r2.example/nessebar-lens-masters/prints/dawn.jpg",
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, "client");
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
});

test("a repeated idempotency key returns the original order, never a second one", async () => {
  // The one-payment-one-order invariant, pinned at the client. Prodigi scopes
  // idempotencyKey per account, remembers it indefinitely, and answers a
  // repeat with 200 / outcome "alreadyExists" carrying the ORIGINAL order —
  // so a webhook redelivery that re-attempts cannot place a second print, and
  // we store the order id Prodigi already knows about rather than trusting our
  // own attempt count.
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const stub = stubFetch(() =>
      json({ outcome: "alreadyExists", order: { id: "ord_first" } }),
    );
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, true, "a duplicate is a success, not an error");
      assert.equal(result.ok && result.orderId, "ord_first");
      // The key sent is the session id, which is what makes the two attempts
      // the same order to Prodigi.
      const sent = JSON.parse(stub.calls[0]!.init.body as string);
      assert.equal(sent.idempotencyKey, "cs_test_abcdefgh");
    } finally {
      stub.restore();
    }
  });
});

test("an unconfigured Prodigi key is a retryable failure, not a crash", async () => {
  // This asserts the *credential* guard, so the HMAC secret has to be usable —
  // without it the asset guard fires first and the test would pass for the
  // wrong reason. That is exactly what the old version of this test did: it
  // deleted the key but not the secret, so prodigi-asset-unconfigured answered
  // first and the key path was never exercised.
  //
  // A throw here used to escape createProdigiOrder entirely and land in the
  // route's catch-all as "orders-kv-unavailable" — a diagnosis pointing at the
  // KV binding rather than the missing key, with no record written at all.
  const saved = process.env.PRODIGI_SANDBOX_API_KEY;
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    const stub = stubFetch(() => json({ order: { id: "ord_127" } }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, "server");
      assert.equal(result.ok === false && result.reason, "prodigi-unconfigured");
      assert.match(result.ok === false ? result.message : "", /API_KEY is not set/);
      assert.equal(stub.calls.length, 0, "Prodigi must never be contacted");
    } finally {
      stub.restore();
    }
  });
  if (saved !== undefined) process.env.PRODIGI_SANDBOX_API_KEY = saved;
});

test("an unrecognised Prodigi host is the same retryable unconfigured failure", async () => {
  // prodigiApiBase throws for anything that is not the sandbox or live host.
  // That is a misconfigured deploy, not a Prodigi outage, so it must carry the
  // same reason: retryable, and the record says "fix the config".
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    process.env.PRODIGI_API_BASE = "https://api.attacker.example";
    const stub = stubFetch(() => json({ order: { id: "ord_128" } }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "prodigi-unconfigured");
      assert.equal(result.ok === false && result.kind, "server");
      assert.equal(stub.calls.length, 0, "an unknown host is never contacted");
    } finally {
      stub.restore();
    }
  });
});

test("resolveOrderAssetUrl returns the signed URL, or null — never a placeholder", async () => {
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const signed = await resolveOrderAssetUrl("dawn");
    assert.equal(signed?.includes("/api/print-asset?"), true);
  });
  await withProdigiEnv(async () => {
    assert.equal(await resolveOrderAssetUrl("dawn"), null);
  });
  await withProdigiEnv(async () => {
    // An unknown slug signs to null even with a secret configured. There is no
    // placeholder path left: null means "cannot fulfill this", not "send the
    // 41KB stand-in".
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    assert.equal(await resolveOrderAssetUrl("not-a-photo"), null);
  });
});

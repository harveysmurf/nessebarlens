import assert from "node:assert/strict";
import test from "node:test";
import { PHOTOS } from "../src/lib/photos.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
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
  assert.equal(body.shippingMethod, "Budget");
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

test("createProdigiOrder posts to the sandbox orders URL and returns the id", async () => {
  await withProdigiEnv(async () => {
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
      // No HMAC secret configured: the public placeholder stands in.
      assert.match(sent.items[0].assets[0].url, /placeholders\/dawn\.jpg$/);
      assert.equal(result.ok && result.assetUrl, sent.items[0].assets[0].url);
    } finally {
      stub.restore();
    }
  });
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

test("Prodigi 4xx is a client failure, 5xx a server failure, and the status survives", async () => {
  for (const [status, kind] of [[422, "client"], [503, "server"]] as const) {
    await withProdigiEnv(async () => {
      const stub = stubFetch(() => json({ error: "nope" }, status));
      try {
        const result = await createProdigiOrder(ORDER_INPUT);
        assert.equal(result.ok, false);
        assert.equal(result.ok === false && result.kind, kind);
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

test("a 200 with no order id is a client failure, not a silent success", async () => {
  await withProdigiEnv(async () => {
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

test("an unconfigured Prodigi key is a server failure, not a crash", async () => {
  const saved = process.env.PRODIGI_SANDBOX_API_KEY;
  await withProdigiEnv(async () => {
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    const stub = stubFetch(() => json({ order: { id: "ord_127" } }));
    try {
      const result = await createProdigiOrder(ORDER_INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, "server");
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
  if (saved !== undefined) process.env.PRODIGI_SANDBOX_API_KEY = saved;
});

test("resolveOrderAssetUrl prefers the signed URL over the placeholder", async () => {
  await withProdigiEnv(async () => {
    process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
    const signed = await resolveOrderAssetUrl("dawn");
    assert.equal(signed.includes("/api/print-asset?"), true);
  });
  await withProdigiEnv(async () => {
    const fallback = await resolveOrderAssetUrl("dawn");
    assert.equal(fallback, "https://nessebarlens.com/placeholders/dawn.jpg");
  });
  await withProdigiEnv(async () => {
    // An unknown slug signs to null, so the placeholder is used even with a
    // secret configured.
    const unknown = await resolveOrderAssetUrl("not-a-photo");
    assert.equal(unknown, "https://nessebarlens.com/placeholders/not-a-photo.jpg");
  });
});

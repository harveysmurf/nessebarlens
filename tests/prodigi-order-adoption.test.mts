/**
 * `AlreadyExists` is an outcome, not a success (#193).
 *
 * Prodigi's idempotency namespace is shared by every deployment that holds the
 * sandbox key, and the first POST defines the order forever. When staging lost
 * that race to a production build, it adopted an order whose `callbackUrl` was
 * null and whose asset was a production placeholder — and recorded a signed
 * staging URL and a stage as if it had placed it. These tests pin the three
 * facts that make that impossible: the response outcome is read, the order is
 * read back from Prodigi rather than assumed, and a foreign order fails instead
 * of claiming success.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProdigiOrderBody,
  createProdigiOrder,
  isForeignOrder,
  prodigiIdempotencyKey,
} from "../src/lib/prodigi-order.ts";
import { prodigiWebhookToken } from "../src/lib/config.ts";
import { sessionOriginCheck } from "../src/lib/stripe-event.ts";
import type { OrderRecipient } from "../src/lib/prodigi-order.ts";

const SANDBOX = "https://api.sandbox.prodigi.com";
const TOKEN = "s3cret-callback-token-0123456789abcdef";

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

const INPUT = {
  sessionId: "cs_test_abcdefgh",
  photoSlug: "dawn",
  format: "giclee" as const,
  size: "30x40" as const,
  frame: null,
  recipient: RECIPIENT,
};

type FetchCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One POST (any outcome) then one GET. Asserted on the method so a test cannot
 * pass by never reaching the lookup at all.
 */
function stubProdigi(handler: {
  post: () => Response;
  get: () => Response;
}): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), init });
    if (method === "POST") return handler.post();
    return handler.get();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withEnv<T>(
  site: string,
  run: () => Promise<T>,
  options: { token?: boolean } = {},
): Promise<T> {
  const saved = {
    base: process.env.PRODIGI_API_BASE,
    key: process.env.PRODIGI_SANDBOX_API_KEY,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    secret: process.env.PRINT_ASSET_HMAC_SECRET,
    token: process.env.PRODIGI_WEBHOOK_TOKEN,
  };
  process.env.PRODIGI_API_BASE = SANDBOX;
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = site;
  process.env.PRINT_ASSET_HMAC_SECRET = "test-print-asset-hmac-secret-32b-min!!";
  if (options.token === false) delete process.env.PRODIGI_WEBHOOK_TOKEN;
  else process.env.PRODIGI_WEBHOOK_TOKEN = TOKEN;
  return run().finally(() => {
    for (const [key, value] of [
      ["PRODIGI_API_BASE", saved.base],
      ["PRODIGI_SANDBOX_API_KEY", saved.key],
      ["NEXT_PUBLIC_SITE_URL", saved.siteUrl],
      ["PRINT_ASSET_HMAC_SECRET", saved.secret],
      ["PRODIGI_WEBHOOK_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Silence the structured logs an adoption or a foreign order emits. */
async function silently<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

test("the idempotency key is bare on production and namespaced elsewhere", () => {
  assert.equal(
    prodigiIdempotencyKey("cs_test_abcdefgh", "https://nessebarlens.com"),
    "cs_test_abcdefgh",
  );
  assert.equal(
    prodigiIdempotencyKey("cs_test_abcdefgh", "https://www.nessebarlens.com"),
    "cs_test_abcdefgh",
  );
  assert.equal(
    prodigiIdempotencyKey("cs_test_abcdefgh", "https://staging.nessebarlens.com"),
    "staging.nessebarlens.com:cs_test_abcdefgh",
  );
  assert.equal(
    prodigiIdempotencyKey("cs_test_abcdefgh", "http://localhost:3000"),
    "localhost:3000:cs_test_abcdefgh",
  );
});

test("the posted body carries the namespaced key and the bare merchantReference", async () => {
  await withEnv("https://staging.nessebarlens.com", async () => {
    const body = buildProdigiOrderBody({
      ...INPUT,
      assetUrl: "https://staging.nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=abc",
      webhookToken: prodigiWebhookToken(),
    });
    assert.equal(
      body.idempotencyKey,
      "staging.nessebarlens.com:cs_test_abcdefgh",
    );
    // The order reference a human reads stays the bare session id.
    assert.equal(body.merchantReference, "cs_test_abcdefgh");
  });
});

test("the callback URL is on the same host as the asset URL", async () => {
  // A callback on another origin than the asset means two deployments disagree
  // about who they are; the foreign-order check downstream is built on these
  // being one origin by construction.
  for (const site of ["https://nessebarlens.com", "https://staging.nessebarlens.com"]) {
    await withEnv(site, async () => {
      const assetUrl = `${site}/api/print-asset?slug=dawn&exp=1&sig=abc`;
      const body = buildProdigiOrderBody({
        ...INPUT,
        assetUrl,
        webhookToken: prodigiWebhookToken(),
      });
      assert.ok(body.callbackUrl);
      assert.equal(new URL(body.callbackUrl!).origin, new URL(assetUrl).origin);
      assert.ok(body.callbackUrl!.startsWith(`${site}/api/webhooks/prodigi?token=`));
    });
  }
});

test("AlreadyExists adopts the order Prodigi holds, not the one we built", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    // Prodigi answers with an id and nothing else — no status, no items.
    const stub = stubProdigi({
      post: () => json({ outcome: "AlreadyExists", order: { id: "ord_1177041" } }),
      get: () =>
        json({
          id: "ord_1177041",
          callbackUrl: `https://nessebarlens.com/api/webhooks/prodigi?token=${TOKEN}`,
          status: { stage: "in-production" },
          items: [
            {
              assets: [
                {
                  url: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1791736976&sig=adopted",
                },
              ],
            },
          ],
        }),
    });
    try {
      const result = await silently(() => createProdigiOrder(INPUT));
      // POST then the lookup — no third call, and no second POST.
      assert.equal(stub.calls.length, 2);
      assert.equal(stub.calls[1]!.url, `${SANDBOX}/v4.0/orders/ord_1177041`);
      assert.equal(stub.calls[1]!.init.method, undefined, "a plain GET");
      assert.ok(result.ok);
      assert.equal(result.value.orderId, "ord_1177041");
      // The stage came from the lookup; the POST carried none.
      assert.equal(result.value.stage, "in-production");
      assert.equal(result.value.reusedExisting, true);
      // Prodigi's asset URL, not the one this process signed.
      assert.match(result.value.assetUrl, /sig=adopted/);
    } finally {
      stub.restore();
    }
  });
});

test("an adopted order on a foreign origin fails instead of claiming success", async () => {
  // The shape #193 found: a production build won the race, so the order holds
  // the production placeholder asset and no callback at all.
  await withEnv("https://staging.nessebarlens.com", async () => {
    const stub = stubProdigi({
      post: () => json({ outcome: "AlreadyExists", order: { id: "ord_1177041" } }),
      get: () =>
        json({
          id: "ord_1177041",
          callbackUrl: null,
          status: { stage: null },
          items: [
            { assets: [{ url: "https://nessebarlens.com/placeholders/dawn.jpg" }] },
          ],
        }),
    });
    try {
      const result = await silently(() => createProdigiOrder(INPUT));
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason === "prodigi-order-foreign");
      // Non-retryable: a redelivery re-sends the same key and gets this order
      // back, so the customer is refunded by a human, not by a retry loop.
      assert.ok(!result.ok && result.kind === "client");
      assert.ok(!result.ok && result.status === 200);
    } finally {
      stub.restore();
    }
  });
});

test("an order with no callback on a token-configured account is foreign", async () => {
  // The asset is on our origin, so an origin check alone would pass this. The
  // tell is the missing callback: our build always sends one when the token is
  // set, so its absence means an older or differently-configured deployment.
  await withEnv("https://staging.nessebarlens.com", async () => {
    const stub = stubProdigi({
      post: () => json({ outcome: "AlreadyExists", order: { id: "ord_9" } }),
      get: () =>
        json({
          id: "ord_9",
          callbackUrl: null,
          status: { stage: "in-production" },
          items: [
            {
              assets: [
                {
                  url: "https://staging.nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=abc",
                },
              ],
            },
          ],
        }),
    });
    try {
      const result = await silently(() => createProdigiOrder(INPUT));
      assert.ok(!result.ok);
      assert.ok(!result.ok && result.reason === "prodigi-order-foreign");
    } finally {
      stub.restore();
    }
  });
});

test("with no token configured, a missing callback is not evidence of anything", async () => {
  // We send no callback in that configuration, so its absence cannot
  // distinguish our own order from a foreign one — refusing it would reject a
  // genuine same-environment retry.
  await withEnv(
    "https://staging.nessebarlens.com",
    async () => {
      const stub = stubProdigi({
        post: () => json({ outcome: "AlreadyExists", order: { id: "ord_10" } }),
        get: () =>
          json({
            id: "ord_10",
            callbackUrl: null,
            status: { stage: "in-production" },
            items: [
              {
                assets: [
                  {
                    url: "https://staging.nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=abc",
                  },
                ],
              },
            ],
          }),
      });
      try {
        const result = await silently(() => createProdigiOrder(INPUT));
        assert.ok(result.ok);
        assert.equal(result.value.orderId, "ord_10");
        assert.equal(result.value.reusedExisting, true);
      } finally {
        stub.restore();
      }
    },
    { token: false },
  );
});

test("isForeignOrder reads origin, not resemblance", () => {
  const ours = {
    id: "ord_1",
    stage: "in-production",
    callbackUrl: "https://nessebarlens.com/api/webhooks/prodigi?token=t",
    assetUrl: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=a",
  };
  const local = {
    localAssetUrl: ours.assetUrl,
    localCallbackUrl: ours.callbackUrl,
    origin: "https://nessebarlens.com",
  };
  assert.equal(isForeignOrder({ existing: ours, ...local }), false);
  assert.equal(
    isForeignOrder({
      existing: { ...ours, assetUrl: "https://nessebarlens.com.evil.test/x.jpg" },
      ...local,
    }),
    true,
  );
  assert.equal(
    isForeignOrder({
      existing: { ...ours, callbackUrl: "https://staging.nessebarlens.com/cb" },
      ...local,
    }),
    true,
  );
  assert.equal(
    isForeignOrder({ existing: { ...ours, assetUrl: null }, ...local }),
    true,
  );
  assert.equal(
    isForeignOrder({ existing: { ...ours, assetUrl: "not a url" }, ...local }),
    true,
  );
  // No token sent, so no callback is expected and its absence is not evidence.
  assert.equal(
    isForeignOrder({
      existing: { ...ours, callbackUrl: null },
      localAssetUrl: ours.assetUrl,
      localCallbackUrl: undefined,
      origin: "https://nessebarlens.com",
    }),
    false,
  );
});

test("a fresh order is unaffected: no lookup, no reuse flag", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    const stub = stubProdigi({
      post: () => json({ order: { id: "ord_1", status: { stage: "awaiting_payment" } } }),
      get: () => json({}),
    });
    try {
      const result = await createProdigiOrder(INPUT);
      assert.ok(result.ok);
      assert.equal(result.value.orderId, "ord_1");
      assert.equal(result.value.reusedExisting, undefined);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
});

test("a failed lookup keeps the failure retryable rather than claiming success", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    const stub = stubProdigi({
      post: () => json({ outcome: "AlreadyExists", order: { id: "ord_1" } }),
      get: () => json({ message: "boom" }, 503),
    });
    try {
      const result = await silently(() => createProdigiOrder(INPUT));
      assert.ok(!result.ok);
      // A Prodigi we could not read is worth retrying; the redelivery re-sends
      // the same key, which is what makes that safe.
      assert.ok(!result.ok && result.reason === "prodigi-unavailable");
      assert.ok(!result.ok && result.kind === "server");
    } finally {
      stub.restore();
    }
  });
});

test("sessionOriginCheck reads success_url, and refuses to guess", () => {
  const ours = "https://nessebarlens.com";
  assert.equal(
    sessionOriginCheck(
      { success_url: "https://nessebarlens.com/checkout/success?session_id=cs_1" },
      ours,
    ),
    "ours",
  );
  // Port and case differ, but the origin is the deployment's.
  assert.equal(
    sessionOriginCheck(
      { success_url: "https://nessebarlens.com:443/checkout/success?x=1" },
      ours,
    ),
    "ours",
  );
  assert.equal(
    sessionOriginCheck(
      { success_url: "https://staging.nessebarlens.com/checkout/success" },
      ours,
    ),
    "foreign",
  );
  // A look-alike host is foreign, not ours: this is the check that decides
  // whether we may write an order at all.
  assert.equal(
    sessionOriginCheck(
      { success_url: "https://nessebarlens.com.evil.test/checkout/success" },
      ours,
    ),
    "foreign",
  );
  // No success_url is not evidence of a foreign session. Refusing here would
  // drop a customer's paid print, so it is accepted.
  assert.equal(sessionOriginCheck({}, ours), "unknown");
  assert.equal(sessionOriginCheck({ success_url: "   " }, ours), "unknown");
  assert.equal(sessionOriginCheck({ success_url: null }, ours), "unknown");
  // Stripe's own placeholder template still parses.
  assert.equal(
    sessionOriginCheck(
      { success_url: "https://nessebarlens.com/c?session_id={CHECKOUT_SESSION_ID}" },
      ours,
    ),
    "ours",
  );
  // Unparseable is unknown, not a rejection.
  assert.equal(sessionOriginCheck({ success_url: "not a url" }, ours), "unknown");
  // An unparseable configured origin cannot classify anything either.
  assert.equal(
    sessionOriginCheck({ success_url: "https://nessebarlens.com/x" }, "nope"),
    "unknown",
  );
});

test("sessionOriginCheck: www and the apex are one deployment, nothing else folds", () => {
  const success = (host: string) => ({
    success_url: `https://${host}/checkout/success?session_id=cs_1`,
  });
  // A checkout started on www while the site url is the apex (or vice versa)
  // is still our session; dropping it would lose a paid print.
  assert.equal(sessionOriginCheck(success("www.nessebarlens.com"), "https://nessebarlens.com"), "ours");
  assert.equal(sessionOriginCheck(success("nessebarlens.com"), "https://www.nessebarlens.com"), "ours");
  // Look-alikes and other subdomains stay foreign; comparison is on parsed hosts.
  for (const host of [
    "staging.nessebarlens.com",
    "www.staging.nessebarlens.com",
    "nessebarlens.com.evil.com",
    "www.nessebarlens.com.evil.com",
    "staging.nessebarlens.com.evil.com",
    "evilnessebarlens.com",
    "nessebarlens.com@evil.com",
  ]) {
    assert.equal(
      sessionOriginCheck(success(host), "https://nessebarlens.com"),
      "foreign",
      host,
    );
  }
  // The scheme and port are part of the origin.
  assert.equal(
    sessionOriginCheck({ success_url: "http://nessebarlens.com/x" }, "https://nessebarlens.com"),
    "foreign",
  );
  assert.equal(
    sessionOriginCheck({ success_url: "https://nessebarlens.com:8443/x" }, "https://nessebarlens.com"),
    "foreign",
  );
});

test("a failed lookup that times out or cannot connect is retryable", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    for (const [error, reason] of [
      [Object.assign(new Error("slow"), { name: "TimeoutError" }), "prodigi-timeout"],
      [new Error("socket hang up"), "prodigi-unavailable"],
      // A runtime that rejects with a non-Error still maps to unavailable.
      ["connection reset", "prodigi-unavailable"],
    ] as const) {
      const stub = stubProdigi({
        post: () => json({ outcome: "AlreadyExists", order: { id: "ord_1" } }),
        get: () => {
          throw error;
        },
      });
      try {
        const result = await silently(() => createProdigiOrder(INPUT));
        assert.ok(!result.ok);
        assert.ok(!result.ok && result.reason === reason);
      } finally {
        stub.restore();
      }
    }
  });
});

test("an unreadable or sparse lookup body is never adopted as ours", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    const bodies: Array<() => Response> = [
      () => new Response("<html>not json</html>", { status: 200 }),
      // The body itself cannot be read.
      () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error("body stream reset");
          },
        }) as unknown as Response,
      // No id, no status, no assets, callback that is not a URL.
      () => json({ callbackUrl: "::nope::" }),
      () => json({ id: 7, status: { stage: 3 }, items: [null], callbackUrl: "" }),
      () => json({ items: [{ assets: [{ url: "not a url" }] }] }),
    ];
    for (const get of bodies) {
      const stub = stubProdigi({
        post: () => json({ outcome: "AlreadyExists", order: { id: "ord_1" } }),
        get,
      });
      try {
        const result = await silently(() => createProdigiOrder(INPUT));
        assert.ok(!result.ok && result.reason === "prodigi-order-foreign");
      } finally {
        stub.restore();
      }
    }
  });
});

test("an adopted order with our asset but no stage is adopted with a null stage", async () => {
  await withEnv("https://nessebarlens.com", async () => {
    const stub = stubProdigi({
      post: () => json({ outcome: "AlreadyExists", order: { id: "ord_5" } }),
      get: () =>
        json({
          callbackUrl: `https://nessebarlens.com/api/webhooks/prodigi?token=${TOKEN}`,
          items: [
            { assets: [{ url: "https://nessebarlens.com/api/print-asset?slug=dawn&sig=z" }] },
          ],
        }),
    });
    try {
      const result = await silently(() => createProdigiOrder(INPUT));
      assert.ok(result.ok);
      // Falls back to the id Prodigi gave on the POST when the body omits it.
      assert.equal(result.value.orderId, "ord_5");
      assert.equal(result.value.stage, null);
    } finally {
      stub.restore();
    }
  });
});

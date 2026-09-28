import assert from "node:assert/strict";
import test from "node:test";
import {
  isMastersBucket,
  isOrdersKv,
  readCloudflareEnv,
  readWorkerBindings,
} from "../src/lib/worker-bindings.ts";

const get = async () => null;
const put = async () => {};

test("ORDERS needs both get and put, MASTERS only get", () => {
  assert.equal(isOrdersKv({ get, put }), true);
  assert.equal(isOrdersKv({ get }), false, "get-only KV would throw on first write");
  assert.equal(isOrdersKv({ put }), false);
  assert.equal(isMastersBucket({ get }), true);
  assert.equal(isMastersBucket({ put }), false);
});

test("binding guards reject non-objects and wrong-typed members", () => {
  for (const bad of [null, undefined, 0, "", "ORDERS", true, Symbol("kv"), [get, put]]) {
    assert.equal(isOrdersKv(bad), false, String(bad));
    assert.equal(isMastersBucket(bad), false, String(bad));
  }
  for (const bad of [{ get: "get", put }, { get: {}, put }, { get, put: null }]) {
    assert.equal(isOrdersKv(bad), false, JSON.stringify(Object.keys(bad)));
  }
  assert.equal(isMastersBucket({ get: "get" }), false);
});

test("guards read the shape, never call the methods", () => {
  let calls = 0;
  const spy = async () => {
    calls++;
    return null;
  };
  assert.equal(isOrdersKv({ get: spy, put: spy }), true);
  assert.equal(isMastersBucket({ get: spy }), true);
  assert.equal(calls, 0);
});

test("readWorkerBindings never returns a binding that fails its own guard", async () => {
  const bindings = await readWorkerBindings();
  if (bindings.ORDERS !== undefined) assert.equal(isOrdersKv(bindings.ORDERS), true);
  if (bindings.MASTERS !== undefined) assert.equal(isMastersBucket(bindings.MASTERS), true);
  // No local Cloudflare context: KV bindings must be absent, never faked.
  assert.equal(bindings.ORDERS, undefined);
  assert.equal(bindings.MASTERS, undefined);
});

const SECRET = "test-print-asset-hmac-secret-32b-min!!";

/* The Cloudflare env path could not be driven before: outside a Worker
   getCloudflareContext always throws, so every test saw the catch branch and
   the success branch — the one production runs — was never executed. */

test("bindings come from the Cloudflare env when it is available", async () => {
  const saved = {
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    print: process.env.PRINT_ASSET_HMAC_SECRET,
    base: process.env.PRODIGI_API_BASE,
    key: process.env.PRODIGI_SANDBOX_API_KEY,
  };
  try {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.PRINT_ASSET_HMAC_SECRET;
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    const orders = { get: async () => null, put: async () => {} };
    const masters = { get: async () => null };
    const bindings = await readWorkerBindings({
      readEnv: async () => ({
        ORDERS: orders,
        MASTERS: masters,
        STRIPE_WEBHOOK_SECRET: "whsec_from_bindings",
        PRINT_ASSET_HMAC_SECRET: SECRET,
        PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
        PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      }),
    });
    assert.equal(bindings.ORDERS, orders);
    assert.equal(bindings.MASTERS, masters);
    assert.equal(bindings.webhookSecret, "whsec_from_bindings");
    assert.equal(bindings.printAssetSecret, SECRET);
    assert.equal(bindings.prodigiKeyConfigured, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a binding that fails its shape guard is dropped, not passed through", async () => {
  const bindings = await readWorkerBindings({
    readEnv: async () => ({
      // Looks like KV, cannot be written to.
      ORDERS: { get: async () => null },
      MASTERS: { get: async () => null, extra: true },
    }),
  });
  assert.equal(bindings.ORDERS, undefined);
  assert.ok(bindings.MASTERS, "an R2 bucket only needs get()");
});

test("a context that throws falls back to process.env, never to a fake binding", async () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_from_process";
    const bindings = await readWorkerBindings({
      readEnv: async () => {
        throw new Error("no Cloudflare context outside a Worker");
      },
    });
    assert.equal(bindings.webhookSecret, "whsec_from_process");
    assert.equal(bindings.ORDERS, undefined);
    assert.equal(bindings.MASTERS, undefined);
  } finally {
    if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

test("the env binding wins over process.env for the webhook secret", async () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_from_process";
    const bindings = await readWorkerBindings({
      readEnv: async () => ({ STRIPE_WEBHOOK_SECRET: "whsec_from_bindings" }),
    });
    assert.equal(bindings.webhookSecret, "whsec_from_bindings");
  } finally {
    if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

test("a short print-asset secret in bindings falls back, a long one wins", async () => {
  const saved = process.env.PRINT_ASSET_HMAC_SECRET;
  try {
    const tooShort = await readWorkerBindings({
      readEnv: async () => ({ PRINT_ASSET_HMAC_SECRET: "x".repeat(31) }),
    });
    assert.equal(tooShort.printAssetSecret, undefined);
    const long = await readWorkerBindings({
      readEnv: async () => ({ PRINT_ASSET_HMAC_SECRET: SECRET }),
    });
    assert.equal(long.printAssetSecret, SECRET);
  } finally {
    if (saved === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
    else process.env.PRINT_ASSET_HMAC_SECRET = saved;
  }
});

test("a Worker context with no env at all reads as empty, not as a crash", async () => {
  // getCloudflareContext resolves before any binding is declared in a fresh
  // worker, so env can be absent. An empty object is the right answer: every
  // binding then fails its shape guard and the request is refused, rather than
  // a TypeError escaping the webhook.
  const env = await readCloudflareEnv(async () => ({
    getCloudflareContext: async () => ({}) as unknown as { env: Record<string, unknown> },
  }));
  assert.deepEqual(env, {});
  const bindings = await readWorkerBindings({ readEnv: async () => env });
  assert.equal(bindings.ORDERS, undefined);
  assert.equal(bindings.MASTERS, undefined);
});

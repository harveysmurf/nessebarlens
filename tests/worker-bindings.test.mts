import assert from "node:assert/strict";
import test from "node:test";
import {
  isMastersBucket,
  isOrdersDatabase,
  isOrdersStore,
  readCloudflareEnv,
  readWorkerBindings,
} from "../src/lib/worker-bindings.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";

const prepare = () => ({ bind() { return this; }, first: async () => null, run: async () => ({ meta: { changes: 0 }, results: [] }), all: async () => ({ results: [] }) });
const batch = async () => [];

test("ORDERS_DB D1 needs prepare and batch; store needs the port methods", () => {
  assert.equal(isOrdersDatabase({ prepare, batch }), true);
  assert.equal(isOrdersDatabase({ prepare }), false, "prepare-only would throw on putDownloadToken");
  assert.equal(isOrdersDatabase({ batch }), false);
  assert.equal(isOrdersStore(memoryOrdersStore()), true);
  assert.equal(isOrdersStore({ getOrder: async () => null }), false);
  assert.equal(isMastersBucket({ get: async () => null }), true);
  assert.equal(isMastersBucket({ put: async () => {} }), false);
});

test("binding guards reject non-objects and wrong-typed members", () => {
  for (const bad of [null, undefined, 0, "", "ORDERS", true, Symbol("db"), [prepare, batch]]) {
    assert.equal(isOrdersDatabase(bad), false, String(bad));
    assert.equal(isOrdersStore(bad), false, String(bad));
    assert.equal(isMastersBucket(bad), false, String(bad));
  }
  for (const bad of [
    { prepare: "prepare", batch },
    { prepare: {}, batch },
    { prepare, batch: null },
  ]) {
    assert.equal(isOrdersDatabase(bad), false, JSON.stringify(Object.keys(bad)));
  }
  assert.equal(isMastersBucket({ get: "get" }), false);
});

test("guards read the shape, never call the methods", () => {
  let calls = 0;
  const spy = () => {
    calls++;
    return prepare();
  };
  const batchSpy = async () => {
    calls++;
    return [];
  };
  assert.equal(isOrdersDatabase({ prepare: spy, batch: batchSpy }), true);
  assert.equal(isMastersBucket({ get: async () => { calls++; return null; } }), true);
  assert.equal(calls, 0);
});

test("readWorkerBindings never returns a binding that fails its own guard", async () => {
  const bindings = await readWorkerBindings();
  if (bindings.ORDERS_DB !== undefined) {
    assert.equal(isOrdersStore(bindings.ORDERS_DB), true);
  }
  if (bindings.MASTERS !== undefined) assert.equal(isMastersBucket(bindings.MASTERS), true);
  assert.equal(bindings.ORDERS_DB, undefined);
  assert.equal(bindings.MASTERS, undefined);
});

const SECRET = "test-print-asset-hmac-secret-32b-min!!";

test("bindings come from the Cloudflare env when it is available", async () => {
  const saved = {
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    print: process.env.PRINT_ASSET_HMAC_SECRET,
    base: process.env.PRODIGI_API_BASE,
    key: process.env.PRODIGI_SANDBOX_API_KEY,
    reconcile: process.env.RECONCILE_SECRET,
    prodigiWebhook: process.env.PRODIGI_WEBHOOK_TOKEN,
    resend: process.env.RESEND_API_KEY,
  };
  try {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.PRINT_ASSET_HMAC_SECRET;
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.RECONCILE_SECRET;
    delete process.env.PRODIGI_WEBHOOK_TOKEN;
    delete process.env.RESEND_API_KEY;
    const orders = memoryOrdersStore();
    const masters = { get: async () => null };
    const bindings = await readWorkerBindings({
      readEnv: async () => ({
        ORDERS_DB: orders,
        MASTERS: masters,
        STRIPE_WEBHOOK_SECRET: "whsec_from_bindings",
        PRINT_ASSET_HMAC_SECRET: SECRET,
        RECONCILE_SECRET: "reconcile-secret-value",
        PRODIGI_WEBHOOK_TOKEN: "prodigi-webhook-token-value",
        RESEND_API_KEY: "re_test_from_bindings",
        PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
        PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      }),
    });
    assert.equal(bindings.ORDERS_DB, orders);
    assert.equal(bindings.MASTERS, masters);
    assert.equal(bindings.webhookSecret, "whsec_from_bindings");
    assert.equal(bindings.printAssetSecret, SECRET);
    assert.equal(bindings.reconcileSecret, "reconcile-secret-value");
    assert.equal(bindings.prodigiWebhookToken, "prodigi-webhook-token-value");
    assert.equal(bindings.resendApiKey, "re_test_from_bindings");
    assert.equal(bindings.prodigiKeyConfigured, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const envKey =
        key === "webhook"
          ? "STRIPE_WEBHOOK_SECRET"
          : key === "print"
            ? "PRINT_ASSET_HMAC_SECRET"
            : key === "base"
              ? "PRODIGI_API_BASE"
              : key === "key"
                ? "PRODIGI_SANDBOX_API_KEY"
                : key === "prodigiWebhook"
                  ? "PRODIGI_WEBHOOK_TOKEN"
                  : key === "resend"
                    ? "RESEND_API_KEY"
                    : "RECONCILE_SECRET";
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test("a raw D1 binding is wrapped as an OrdersStore", async () => {
  const db = { prepare, batch };
  const bindings = await readWorkerBindings({
    readEnv: async () => ({ ORDERS_DB: db }),
  });
  assert.ok(bindings.ORDERS_DB);
  assert.equal(isOrdersStore(bindings.ORDERS_DB), true);
  assert.notEqual(bindings.ORDERS_DB, db);
});

test("a binding that fails its shape guard is dropped, not passed through", async () => {
  const bindings = await readWorkerBindings({
    readEnv: async () => ({
      ORDERS_DB: { prepare: async () => null },
      MASTERS: { get: async () => null, extra: true },
    }),
  });
  assert.equal(bindings.ORDERS_DB, undefined);
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
    assert.equal(bindings.ORDERS_DB, undefined);
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
  const env = await readCloudflareEnv(async () => ({
    getCloudflareContext: async () => ({}) as unknown as { env: Record<string, unknown> },
  }));
  assert.deepEqual(env, {});
  const bindings = await readWorkerBindings({ readEnv: async () => env });
  assert.equal(bindings.ORDERS_DB, undefined);
  assert.equal(bindings.MASTERS, undefined);
});

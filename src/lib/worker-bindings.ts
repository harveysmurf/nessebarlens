import type { MastersBucket } from "./master-key";
import type { OrdersStore } from "./orders-store";
import { envString } from "./env";
import { printAssetSecret } from "./config";
import { prodigiKeyConfigured } from "./prodigi-config";
import { devOrdersSeed } from "./orders-dev-seed";
import { d1OrdersStore } from "./orders-d1";

export type WorkerBindings = {
  ORDERS_DB?: OrdersStore;
  MASTERS?: MastersBucket;
  webhookSecret?: string;
  printAssetSecret?: string;
  reconcileSecret?: string;
  prodigiKeyConfigured: boolean;
};

/** The Cloudflare env object, as getCloudflareContext returns it. */
export type CloudflareEnv = Record<string, unknown>;

/** Reads the Worker env. Injectable so tests can drive the real binding path. */
export type EnvContextReader = () => Promise<CloudflareEnv>;

type CloudflareContextModule = {
  getCloudflareContext: (options?: { async: boolean }) => Promise<{
    env: CloudflareEnv;
  }>;
};

/** The dynamic import is a parameter so a test can supply a context module. */
const loadCloudflareModule = (): Promise<CloudflareContextModule> =>
  import("@opennextjs/cloudflare") as unknown as Promise<CloudflareContextModule>;

/**
 * Reads the real Worker env. Exported for the tests that need a context whose
 * `env` is present but empty, which is what a fresh binding looks like.
 */
export async function readCloudflareEnv(
  load: () => Promise<CloudflareContextModule> = loadCloudflareModule,
): Promise<CloudflareEnv> {
  const mod = await load();
  const ctx = await mod.getCloudflareContext({ async: true });
  return ctx.env ?? {};
}

/**
 * ORDERS_DB is the D1 database `nessebar-lens-orders`.
 * MASTERS is the private nessebar-lens-masters binding. It may be absent
 * until R2 is enabled. Never fall back to an S3 URL.
 *
 * The KV `ORDERS` binding remains in wrangler.toml for the one-shot migration
 * script only — nothing here reads it.
 */
export async function readWorkerBindings(
  options: { readEnv?: EnvContextReader } = {},
): Promise<WorkerBindings> {
  let env: CloudflareEnv = {};
  try {
    env = await (options.readEnv ?? readCloudflareEnv)();
  } catch {
    env = {};
  }

  const webhookSecret = envString("STRIPE_WEBHOOK_SECRET", env);
  // Same reader as the sign/verify path, so bindings can never accept a
  // secret that verify would reject (or vice versa). No `?? printAssetSecret()`
  // fallback: envString already falls back to process.env, so a null here
  // means absent from both sources, not "absent from the Worker env".
  const printAsset = printAssetSecret(env);
  const reconcileSecret = envString("RECONCILE_SECRET", env);

  // The dev seed wins *over* a binding, not only in its absence. `next dev`
  // mounts a real local D1 (or empty proxy) for ORDERS_DB through
  // initOpenNextCloudflareForDev, so isOrdersDatabase passes and the namespace
  // is genuinely empty — the three success-page states are then unreachable on
  // any `next` server. The seed is opt-in (ORDERS_DEV_SEED must name a JSON
  // file) and already refuses to run under NODE_ENV=production, so preferring
  // it cannot reach a deployed build; a developer who sets the flag has asked
  // for the fixture over whatever binding their `next` server happens to have.
  const seeded = devOrdersSeed(env);
  const fromBinding = isOrdersDatabase(env.ORDERS_DB)
    ? d1OrdersStore(env.ORDERS_DB)
    : isOrdersStore(env.ORDERS_DB)
      ? env.ORDERS_DB
      : undefined;

  return {
    ORDERS_DB: seeded ?? fromBinding,
    MASTERS: isMastersBucket(env.MASTERS) ? env.MASTERS : undefined,
    webhookSecret,
    printAssetSecret: printAsset ?? undefined,
    reconcileSecret,
    prodigiKeyConfigured: prodigiKeyConfigured(env),
  };
}

/** True when the value is an object exposing every named method. */
function hasMethods(
  value: unknown,
  ...names: string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return names.every((name) => typeof candidate[name] === "function");
}

/**
 * A D1 database needs prepare *and* batch — token writes use batch, and a
 * prepare-only binding would pass the check and then throw on first mint.
 * Exported for the binding-shape tests.
 */
export function isOrdersDatabase(value: unknown): value is import("@cloudflare/workers-types").D1Database {
  return hasMethods(value, "prepare", "batch");
}

/**
 * An already-wrapped OrdersStore (dev seed, tests). Distinguished from a raw
 * D1 binding by the port method names rather than prepare/batch.
 */
export function isOrdersStore(value: unknown): value is OrdersStore {
  return hasMethods(
    value,
    "getOrder",
    "putOrder",
    "transitionOrder",
    "listOrders",
    "getDownloadToken",
    "putDownloadToken",
    "findDownloadToken",
    "spendDownloadToken",
  );
}

/** R2 is read-only from here, so get() is the whole contract. */
export function isMastersBucket(value: unknown): value is MastersBucket {
  return hasMethods(value, "get");
}

import type { MastersBucket, OrdersKv } from "./fulfillment";
import { envString } from "./env";
import { printAssetSecret } from "./print-asset";
import { prodigiKeyConfigured } from "./prodigi-config";

export type WorkerBindings = {
  ORDERS?: OrdersKv;
  MASTERS?: MastersBucket;
  webhookSecret?: string;
  printAssetSecret?: string;
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
 * ORDERS is KV id c6f34450a61c4c69b3f840e845a7b0d3.
 * MASTERS is the private nessebar-lens-masters binding. It may be absent
 * until R2 is enabled. Never fall back to an S3 URL.
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
  // secret that verify would reject (or vice versa).
  const printAsset = printAssetSecret(env) ?? printAssetSecret();

  return {
    ORDERS: isOrdersKv(env.ORDERS) ? env.ORDERS : undefined,
    MASTERS: isMastersBucket(env.MASTERS) ? env.MASTERS : undefined,
    webhookSecret,
    printAssetSecret: printAsset ?? undefined,
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
 * A KV namespace needs get *and* put — fulfillment writes ORDERS records, so
 * a get-only binding would pass the check and then throw on first write.
 * Exported for the binding-shape tests.
 */
export function isOrdersKv(value: unknown): value is OrdersKv {
  return hasMethods(value, "get", "put");
}

/** R2 is read-only from here, so get() is the whole contract. */
export function isMastersBucket(value: unknown): value is MastersBucket {
  return hasMethods(value, "get");
}

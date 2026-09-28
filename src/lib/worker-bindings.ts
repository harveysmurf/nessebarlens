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

/**
 * ORDERS is KV id c6f34450a61c4c69b3f840e845a7b0d3.
 * MASTERS is the private nessebar-lens-masters binding. It may be absent
 * until R2 is enabled. Never fall back to an S3 URL.
 */
export async function readWorkerBindings(): Promise<WorkerBindings> {
  let env: Record<string, unknown> = {};
  try {
    const mod = (await import("@opennextjs/cloudflare")) as unknown as {
      getCloudflareContext: (options?: { async: boolean }) => Promise<{
        env: Record<string, unknown>;
      }>;
    };
    const ctx = await mod.getCloudflareContext({ async: true });
    env = ctx.env ?? {};
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

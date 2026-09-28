import type { MastersBucket, OrdersKv } from "./fulfillment";
import { printAssetSecret } from "./print-asset";
import { prodigiKeyConfigured } from "./prodigi-config";

export type WorkerBindings = {
  ORDERS?: OrdersKv;
  MASTERS?: MastersBucket;
  webhookSecret?: string;
  printAssetSecret?: string;
  prodigiKeyConfigured: boolean;
};

function nonempty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

  const webhookSecret =
    nonempty(env.STRIPE_WEBHOOK_SECRET) ??
    nonempty(process.env.STRIPE_WEBHOOK_SECRET);
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

function isOrdersKv(value: unknown): value is OrdersKv {
  if (!value || typeof value !== "object") return false;
  const kv = value as { get?: unknown; put?: unknown };
  return typeof kv.get === "function" && typeof kv.put === "function";
}

function isMastersBucket(value: unknown): value is MastersBucket {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { get?: unknown }).get === "function";
}

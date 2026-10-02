/**
 * A local, in-memory ORDERS for `next dev`, off by default (#143).
 *
 * ORDERS is a Cloudflare KV binding with no env fallback, so on a bare dev
 * server the success page can only ever render "processing" — the digital-paid
 * and physical branches are unreachable without a deployed Worker. The E2E
 * success-state spec needs to render all three, and the boring answer is to seed
 * the records rather than stand up a Worker or a webhook loop (Architect, on
 * #143).
 *
 * Two gates, both required, and the second is the one that matters:
 *
 *   - `ORDERS_DEV_SEED` must be set to a JSON file path. Nothing is seeded by
 *     default, so every other dev and test run is untouched.
 *   - `NODE_ENV` must not be "production". That is the guard keeping fabricated
 *     orders out of a deployed build. The flag alone would be one env var away
 *     from serving a fake download to a real customer, so the production check
 *     is a hard refusal rather than a preference.
 *
 * This module is a KV *shape* and nothing more. It implements get and put
 * because isOrdersKv() requires both, and put is what keeps the seed on the
 * page's own read path rather than on a parallel mock: the same records are read
 * back through order-state.ts, order-decision.ts and parseOrderRecord exactly as
 * a real KV read would be.
 */

import { readFileSync } from "node:fs";
import type { OrdersKv } from "./fulfillment";
import { envString } from "./env";
import { isProduction, type ConfigEnv } from "./config";

/**
 * A KV namespace backed by a Map, seeded from a JSON file.
 *
 * In-memory and per-process on purpose: nothing here may outlive the dev server
 * it belongs to, and a seed that survived a restart would let a stale fixture
 * stand in for a fresh checkout.
 */
export function seededOrdersKv(path: string): OrdersKv {
  const store = new Map<string, string>(loadSeedFile(path));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

/**
 * The seed KV, or undefined when seeding is off or refused.
 *
 * `undefined` is the same answer readWorkerBindings already gives for an absent
 * binding, so every caller degrades to "processing" exactly as it does with no
 * binding at all — the seed is a way to *add* states, never a new mode.
 *
 * The env is passed in rather than read here: worker-bindings.ts is the module
 * that owns env reads (tests/config-reads-env.test.mts enforces it), so this
 * stays a pure function of an env record and testable without mutating
 * process.env.
 *
 * @throws when the flag is set but unusable. A broken fixture must fail the run
 * loudly rather than degrade to "processing" and let the spec pass on the one
 * state it already had.
 */
export function devOrdersSeed(env: ConfigEnv = {}): OrdersKv | undefined {
  const path = envString("ORDERS_DEV_SEED", env);
  if (!path) return undefined;
  if (isProduction(env)) {
    throw new Error(
      "refusing to use ORDERS_DEV_SEED: NODE_ENV is production. A seeded " +
        "ORDERS would serve fabricated orders to real customers.",
    );
  }
  return seededOrdersKv(path);
}

function loadSeedFile(path: string): [string, string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `ORDERS_DEV_SEED: cannot read seed file ${path}. A broken fixture must ` +
        `fail the run, not degrade to "processing" and pass.`,
      { cause },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `ORDERS_DEV_SEED: ${path} must be a JSON object of sessionId -> record`,
    );
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(
        `ORDERS_DEV_SEED: ${path} entry ${key} must be a JSON *string* (a ` +
          `serialised OrderRecord), not a nested object. A KV value is the ` +
          `exact bytes fulfillment.ts writes, so the fixture must be too.`,
      );
    }
  }
  return entries as [string, string][];
}
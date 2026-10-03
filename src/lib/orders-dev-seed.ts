/**
 * A local, in-memory orders store for `next dev`, off by default (#143 / #116).
 *
 * ORDERS_DB is a Cloudflare D1 binding with no env fallback, so on a bare dev
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
 * This module implements the full OrdersStore port (including the atomic
 * download counter), because the E2E success-state spec reads through it. The
 * seed file format stays a JSON object of sessionId -> serialised record
 * string, with optional `dl:` / `dls:` keys for download tokens from the KV
 * era that the loader folds into the store's token maps.
 */

import { readFileSync } from "node:fs";
import type { OrdersStore } from "./orders-store";
import { envString } from "./env";
import { isProduction, type ConfigEnv } from "./config";
import {
  parseDownloadTokenRecord,
  type DownloadTokenIndex,
  type DownloadTokenRecord,
} from "./download-token";
import {
  parseOrderRecord,
  type OrderRecord,
  type OrderStatus,
} from "./order-decision";
import { clampOrderListLimit, type OrderStatusFilter } from "./orders-store";

/**
 * An OrdersStore backed by Maps, seeded from a JSON file.
 *
 * In-memory and per-process on purpose: nothing here may outlive the
 * `next` server it belongs to, and a seed that survived a restart would let
 * a stale fixture stand in for a fresh checkout.
 */
export function seededOrdersStore(path: string): OrdersStore {
  const { orders, tokens, indexes } = loadSeedFile(path);
  return memoryStoreFromMaps(orders, tokens, indexes);
}

/**
 * The seed store, or undefined when seeding is off or refused.
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
export function devOrdersSeed(env: ConfigEnv = {}): OrdersStore | undefined {
  const path = envString("ORDERS_DEV_SEED", env);
  if (!path) return undefined;
  if (isProduction(env)) {
    throw new Error(
      "refusing to use ORDERS_DEV_SEED: NODE_ENV is production. A seeded " +
        "ORDERS store would serve fabricated orders to real customers.",
    );
  }
  return seededOrdersStore(path);
}

function loadSeedFile(path: string): {
  orders: Map<string, string>;
  tokens: Map<string, string>;
  indexes: Map<string, string>;
} {
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
  const orders = new Map<string, string>();
  const tokens = new Map<string, string>();
  const indexes = new Map<string, string>();
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(
        `ORDERS_DEV_SEED: ${path} entry ${key} must be a JSON *string* (a ` +
          `serialised OrderRecord), not a nested object. A store value is the ` +
          `exact bytes fulfillment.ts writes, so the fixture must be too.`,
      );
    }
    if (key.startsWith("dl:")) {
      tokens.set(key.slice(3), value);
    } else if (key.startsWith("dls:")) {
      indexes.set(key.slice(4), value);
    } else {
      orders.set(key, value);
    }
  }
  return { orders, tokens, indexes };
}

function memoryStoreFromMaps(
  orders: Map<string, string>,
  tokens: Map<string, string>,
  indexes: Map<string, string>,
): OrdersStore {
  return {
    async getOrder(sessionId) {
      return orders.get(sessionId) ?? null;
    },
    async putOrder(record) {
      const stored: OrderRecord = {
        ...record,
        attempts: 1,
        createdAt: record.createdAt || record.updatedAt,
      };
      orders.set(stored.sessionId, JSON.stringify(stored));
    },
    async transitionOrder(input) {
      const raw = orders.get(input.sessionId);
      if (raw === undefined) return false;
      const current = parseOrderRecord(raw);
      if (!current || current.attempts !== input.fromAttempts) return false;
      const stored: OrderRecord = {
        ...input.record,
        attempts: input.fromAttempts + 1,
        createdAt: input.record.createdAt || current.createdAt,
      };
      orders.set(input.sessionId, JSON.stringify(stored));
      return true;
    },
    async listOrders(filter) {
      const limit = clampOrderListLimit(filter.limit);
      const parsed: OrderRecord[] = [];
      for (const raw of orders.values()) {
        const order = parseOrderRecord(raw);
        if (!order) continue;
        if (!matchesFilter(order, filter)) continue;
        parsed.push(order);
      }
      parsed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return parsed.slice(0, limit);
    },
    async getDownloadToken(token) {
      return tokens.get(token) ?? null;
    },
    async putDownloadToken(record: DownloadTokenRecord, index: DownloadTokenIndex) {
      tokens.set(index.token, JSON.stringify(record));
      indexes.set(record.sessionId, JSON.stringify(index));
    },
    async findDownloadToken(sessionId) {
      return indexes.get(sessionId) ?? null;
    },
    async spendDownloadToken(token, nowMs) {
      const raw = tokens.get(token);
      if (raw === undefined) return { kind: "missing" };
      const record = parseDownloadTokenRecord(raw);
      if (!record) return { kind: "missing" };
      const nowSec = Math.floor(nowMs / 1000);
      if (record.expiresAt <= nowSec) return { kind: "expired" };
      if (record.remaining <= 0) return { kind: "exhausted" };
      const spent: DownloadTokenRecord = {
        ...record,
        remaining: record.remaining - 1,
      };
      tokens.set(token, JSON.stringify(spent));
      indexes.set(spent.sessionId, JSON.stringify({ ...spent, token }));
      return { kind: "spent", record: spent };
    },
  };
}

function matchesFilter(order: OrderRecord, filter: OrderStatusFilter): boolean {
  if (filter.retryable) {
    return order.status === "paid-unfulfilled" && !order.terminal;
  }
  if (filter.revoked) {
    return order.status === "refunded" || order.status === "disputed";
  }
  if (filter.status && filter.status.length > 0) {
    return (filter.status as readonly OrderStatus[]).includes(order.status);
  }
  return true;
}

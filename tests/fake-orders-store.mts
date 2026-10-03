/**
 * Shared in-memory OrdersStore for tests and the dev seed (#116).
 *
 * One fake, extended per-file, is what makes the functions-100 coverage floor
 * tractable: every port method has a real implementation here, including the
 * atomic spend counter and the transitionOrder changes boolean, so a test that
 * only needs get/put still exercises the same shape the D1 path uses.
 */

import {
  parseOrderRecord,
  type OrderRecord,
  type OrderStatus,
} from "../src/lib/order-decision.ts";
import {
  parseDownloadTokenRecord,
  type DownloadTokenIndex,
  type DownloadTokenRecord,
} from "../src/lib/download-token.ts";
import {
  clampOrderListLimit,
  type OrderStatusFilter,
  type OrdersStore,
} from "../src/lib/orders-store.ts";
import { DOWNLOAD_TOKEN_MAX_DOWNLOADS } from "../src/lib/download-token.ts";

export type MemoryOrdersStore = OrdersStore & {
  /** Session ids written by putOrder / transitionOrder, for assertions. */
  orderPuts: string[];
  /** Raw order JSON by session id. */
  orders: Map<string, string>;
  /** Token JSON by token string. */
  tokens: Map<string, string>;
  /** Index JSON by session id. */
  indexes: Map<string, string>;
  /** Claimed Prodigi CloudEvent ids (#117). */
  prodigiCallbacks: Set<string>;
};

/**
 * Build an in-memory store, optionally seeded with raw order JSON and/or
 * token records (the seed file's `dl:` / `dls:` keys).
 */
export function memoryOrdersStore(seed?: {
  orders?: Record<string, string>;
  tokens?: Record<string, { record: DownloadTokenRecord; index: DownloadTokenIndex }>;
  /** Legacy KV-shaped seed: sessionId -> order JSON, plus dl:/dls: keys. */
  kv?: Record<string, string>;
}): MemoryOrdersStore {
  const orders = new Map<string, string>();
  const tokens = new Map<string, string>();
  const indexes = new Map<string, string>();
  const prodigiCallbacks = new Set<string>();
  const orderPuts: string[] = [];

  if (seed?.orders) {
    for (const [id, raw] of Object.entries(seed.orders)) orders.set(id, raw);
  }
  if (seed?.tokens) {
    for (const [token, { record, index }] of Object.entries(seed.tokens)) {
      tokens.set(token, JSON.stringify(record));
      indexes.set(record.sessionId, JSON.stringify(index));
    }
  }
  if (seed?.kv) {
    for (const [key, value] of Object.entries(seed.kv)) {
      if (key.startsWith("dl:")) {
        tokens.set(key.slice(3), value);
      } else if (key.startsWith("dls:")) {
        indexes.set(key.slice(4), value);
      } else {
        orders.set(key, value);
      }
    }
  }

  const store: MemoryOrdersStore = {
    orderPuts,
    orders,
    tokens,
    indexes,
    prodigiCallbacks,

    async getOrder(sessionId) {
      return orders.get(sessionId) ?? null;
    },

    async putOrder(record) {
      const stored: OrderRecord = {
        ...record,
        attempts: 1,
        createdAt: record.createdAt || record.updatedAt,
      };
      orderPuts.push(stored.sessionId);
      orders.set(stored.sessionId, JSON.stringify(stored));
    },

    async transitionOrder(input) {
      const raw = orders.get(input.sessionId);
      if (raw === null || raw === undefined) return false;
      const current = parseOrderRecord(raw);
      if (!current || current.attempts !== input.fromAttempts) return false;
      const stored: OrderRecord = {
        ...input.record,
        attempts: input.fromAttempts + 1,
        createdAt: input.record.createdAt || current.createdAt,
      };
      orderPuts.push(stored.sessionId);
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

    async putDownloadToken(record, index) {
      void DOWNLOAD_TOKEN_MAX_DOWNLOADS;
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
      const index: DownloadTokenIndex = { ...spent, token };
      tokens.set(token, JSON.stringify(spent));
      indexes.set(spent.sessionId, JSON.stringify(index));
      return { kind: "spent", record: spent };
    },

    async claimProdigiCallback(eventId) {
      if (prodigiCallbacks.has(eventId)) return false;
      prodigiCallbacks.add(eventId);
      return true;
    },
  };

  return store;
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

/**
 * D1 implementation of the OrdersStore port (#116).
 *
 * Every statement uses bound parameters — a reviewer grepping for string
 * interpolation into SQL should find none. Conditional writes read
 * `meta.changes` (declared on D1Meta in `@cloudflare/workers-types`) to
 * produce the boolean: that is the whole point of moving off KV, and a
 * boolean derived from a prior read would reintroduce the race.
 *
 * `record` columns hold the JSON so order-decision.ts / download-token.ts
 * remain the only parsers; the flanking columns are an index over that JSON
 * plus the optimistic-lock counter. Stays free of `next/server`.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  parseOrderRecord,
  type OrderRecord,
  type OrderStatus,
} from "./order-decision";
import {
  parseDownloadTokenRecord,
  type DownloadTokenRecord,
} from "./download-token";
import {
  clampOrderListLimit,
  type OrderStatusFilter,
  type OrdersStore,
} from "./orders-store";
import { DOWNLOAD_TOKEN_MAX_DOWNLOADS } from "./download-token";

type OrderRow = {
  record: string;
};

type TokenRow = {
  record: string;
  downloads: number;
  expires_at: number;
  session_id: string;
};

type IndexRow = {
  index_record: string;
};

type SpendRow = {
  session_id: string;
  expires_at: number;
  downloads: number;
  record: string;
};

/**
 * Build the OrdersStore over a D1 database.
 *
 * The binding shape is checked by `isOrdersDatabase` before this is called;
 * this function trusts that `db` exposes `prepare` and `batch`.
 */
export function d1OrdersStore(db: D1Database): OrdersStore {
  return {
    async getOrder(sessionId) {
      const row = await db
        .prepare("SELECT record FROM orders WHERE session_id = ?")
        .bind(sessionId)
        .first<OrderRow>();
      // D1's `first()` is `T | null`, so there is no third "present but
      // empty" state to spell a fallback for.
      return row === null ? null : row.record;
    },

    async putOrder(record) {
      const stored = withAttempts(record, 1);
      await db
        .prepare(
          `INSERT INTO orders (
             session_id, record, status, terminal, reason,
             attempts, updated_at, created_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             record = excluded.record,
             status = excluded.status,
             terminal = excluded.terminal,
             reason = excluded.reason,
             attempts = 1,
             updated_at = excluded.updated_at,
             created_at = excluded.created_at`,
        )
        .bind(
          stored.sessionId,
          JSON.stringify(stored),
          stored.status,
          stored.terminal ? 1 : 0,
          stored.reason,
          stored.updatedAt,
          stored.createdAt,
        )
        .run();
    },

    async transitionOrder(input) {
      const nextAttempts = input.fromAttempts + 1;
      const stored = withAttempts(input.record, nextAttempts);
      const result = await db
        .prepare(
          `UPDATE orders SET
             record = ?, status = ?, terminal = ?, reason = ?,
             attempts = ?, updated_at = ?
           WHERE session_id = ? AND attempts = ?`,
        )
        .bind(
          JSON.stringify(stored),
          stored.status,
          stored.terminal ? 1 : 0,
          stored.reason,
          nextAttempts,
          stored.updatedAt,
          input.sessionId,
          input.fromAttempts,
        )
        .run();
      // D1Meta.changes is a required number, so the boolean comes straight off
      // the statement: no prior read, no fallback, no second chance to be wrong.
      return result.meta.changes > 0;
    },

    async listOrders(filter) {
      const { sql, binds } = listOrdersQuery(filter);
      const result = await db
        .prepare(sql)
        .bind(...binds)
        .all<OrderRow>();
      const out: OrderRecord[] = [];
      for (const row of result.results) {
        const parsed = parseOrderRecord(row.record);
        if (parsed) out.push(parsed);
      }
      return out;
    },

    async getDownloadToken(token) {
      const row = await db
        .prepare("SELECT record FROM download_tokens WHERE token = ?")
        .bind(token)
        .first<OrderRow>();
      // D1's `first()` is `T | null`, so there is no third "present but
      // empty" state to spell a fallback for.
      return row === null ? null : row.record;
    },

    async putDownloadToken(record, index) {
      const maxDownloads = DOWNLOAD_TOKEN_MAX_DOWNLOADS;
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO download_tokens (
               token, session_id, expires_at, max_downloads, downloads,
               record, index_record
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(token) DO UPDATE SET
               session_id = excluded.session_id,
               expires_at = excluded.expires_at,
               max_downloads = excluded.max_downloads,
               downloads = excluded.downloads,
               record = excluded.record,
               index_record = excluded.index_record`,
          )
          .bind(
            index.token,
            record.sessionId,
            record.expiresAt,
            maxDownloads,
            record.remaining,
            JSON.stringify(record),
            JSON.stringify(index),
          ),
      ];
      await db.batch(statements);
    },

    async findDownloadToken(sessionId) {
      const row = await db
        .prepare(
          "SELECT index_record FROM download_tokens WHERE session_id = ?",
        )
        .bind(sessionId)
        .first<IndexRow>();
      return row === null ? null : row.index_record;
    },

    async spendDownloadToken(token, nowMs) {
      const nowSec = Math.floor(nowMs / 1000);
      // Decrement and rewrite both JSON blobs in one statement so a concurrent
      // reader of getDownloadToken / findDownloadToken cannot see a stale
      // remaining count. RHS column refs are the pre-update values in SQLite.
      const spent = await db
        .prepare(
          `UPDATE download_tokens SET
             downloads = downloads - 1,
             record = json_object(
               'v', 1,
               'sessionId', session_id,
               'expiresAt', expires_at,
               'remaining', downloads - 1
             ),
             index_record = json_object(
               'v', 1,
               'sessionId', session_id,
               'expiresAt', expires_at,
               'remaining', downloads - 1,
               'token', token
             )
           WHERE token = ? AND expires_at > ? AND downloads > 0
           RETURNING session_id, expires_at, downloads, record`,
        )
        .bind(token, nowSec)
        .first<SpendRow>();

      if (spent) {
        const record =
          parseDownloadTokenRecord(spent.record) ??
          ({
            v: 1,
            sessionId: spent.session_id,
            expiresAt: spent.expires_at,
            remaining: spent.downloads,
          } satisfies DownloadTokenRecord);
        return { kind: "spent", record };
      }

      const existing = await db
        .prepare(
          "SELECT record, downloads, expires_at, session_id FROM download_tokens WHERE token = ?",
        )
        .bind(token)
        .first<TokenRow>();
      if (!existing) return { kind: "missing" };
      if (existing.expires_at <= nowSec) return { kind: "expired" };
      if (existing.downloads <= 0) return { kind: "exhausted" };
      // Row exists, not expired, has downloads — the UPDATE raced with another
      // spend that took the last one between our statements. Treat as exhausted
      // so the customer sees the same 410 they would for a fully spent token.
      return { kind: "exhausted" };
    },
  };
}

function withAttempts(record: OrderRecord, attempts: number): OrderRecord {
  return {
    ...record,
    attempts,
    createdAt: record.createdAt || record.updatedAt,
  };
}

/**
 * Build the parameterised list query. Exported for the migration/operator
 * script tests that assert the SQL stays bound-parameter, never interpolated.
 */
export function listOrdersQuery(filter: OrderStatusFilter): {
  sql: string;
  binds: unknown[];
} {
  const limit = clampOrderListLimit(filter.limit);
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (filter.retryable) {
    clauses.push("status = ? AND terminal = 0");
    binds.push("paid-unfulfilled" satisfies OrderStatus);
  } else if (filter.revoked) {
    clauses.push("status IN (?, ?)");
    binds.push("refunded", "disputed");
  } else if (filter.status && filter.status.length > 0) {
    clauses.push(
      `status IN (${filter.status.map(() => "?").join(", ")})`,
    );
    binds.push(...filter.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT record FROM orders ${where} ORDER BY created_at ASC LIMIT ?`;
  binds.push(limit);
  return { sql, binds };
}

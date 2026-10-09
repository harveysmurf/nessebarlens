/**
 * The orders storage port, owned by the domain (#116).
 *
 * The application depends on this interface; `infrastructure/cloudflare/orders-d1.ts`
 * is the D1 implementation and `orders-dev-seed.ts` is the in-memory test/dev
 * implementation.
 */

import type { OrderRecord, OrderStatus } from "./order-decision";
import type { DownloadTokenIndex, DownloadTokenRecord } from "./download-token";

/** One spelling of "the ORDERS store binding is not usable". */
export const ORDERS_STORE_UNAVAILABLE_ERROR = "orders-store-unavailable";
export const ORDERS_STORE_UNAVAILABLE_STATUS = 503;

/** Default page size for `listOrders` when the caller omits `limit`. */
export const ORDERS_LIST_DEFAULT_LIMIT = 100;

/** Hard ceiling on `listOrders`. A caller that asks for more is clamped, not refused. */
export const ORDERS_LIST_MAX_LIMIT = 500;

export type OrderStatusFilter = {
  /** Exact statuses. Omit for "every status". */
  status?: readonly OrderStatus[];
  /**
   * The reconciler's predicate: paid-unfulfilled AND terminal = 0, in one
   * indexed query.
   */
  retryable?: boolean;
  /** Revoked orders, for the operator view. */
  revoked?: boolean;
  /** Optional bound; the default and the maximum are both named constants. */
  limit?: number;
};

export type OrdersStore = {
  /** Raw stored JSON for a session, or null. Throws if the store is unreachable. */
  getOrder(sessionId: string): Promise<string | null>;

  /** Unconditional put — creates the row with attempts = 1. */
  putOrder(record: OrderRecord): Promise<void>;

  /**
   * Optimistic lock. Succeeds only while the row's `attempts` column is still
   * exactly `fromAttempts`; writes `record` and bumps attempts to
   * fromAttempts + 1 in the same statement.
   */
  transitionOrder(input: {
    sessionId: string;
    fromAttempts: number;
    record: OrderRecord;
  }): Promise<boolean>;

  /** The operator view and the reconciler's source, in one query. */
  listOrders(filter: OrderStatusFilter): Promise<OrderRecord[]>;

  /** Raw token record for `token`, or null. */
  getDownloadToken(token: string): Promise<string | null>;

  /** Token record plus its reverse index, written in one transaction. */
  putDownloadToken(
    record: DownloadTokenRecord,
    index: DownloadTokenIndex,
  ): Promise<void>;

  /** The reverse-index value for a session, or null. */
  findDownloadToken(sessionId: string): Promise<string | null>;

  /**
   * Spend one download and return the post-spend record.
   * ONE statement: UPDATE download_tokens SET downloads = downloads - 1
   *   WHERE token = ? AND expires_at > ? AND downloads > 0
   *   RETURNING ...
   */
  spendDownloadToken(
    token: string,
    nowMs: number,
  ): Promise<
    | { kind: "spent"; record: DownloadTokenRecord }
    | { kind: "missing" | "expired" | "exhausted" }
  >;

  /** Claim a Prodigi CloudEvent id for callback dedupe (#117). */
  claimProdigiCallback(eventId: string): Promise<boolean>;
};

/**
 * Clamp a caller-supplied list limit into the named default/max window.
 * Exported so the D1 implementation, the in-memory seed, and the test fake
 * cannot each invent a different clamp.
 */
export function clampOrderListLimit(limit: number | undefined): number {
  if (limit === undefined) return ORDERS_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return ORDERS_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), ORDERS_LIST_MAX_LIMIT);
}

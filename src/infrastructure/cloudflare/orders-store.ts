/**
 * The orders storage port (#116).
 *
 * The methods are deliberately not get/put: raw-string reads stay so
 * `order-corrupt.ts` can keep reporting unreadable records unchanged, but the
 * store also does the three things a plain key-value map cannot — a
 * conditional write, a query, and an atomic counter. Callers talk to this
 * port; `orders-d1.ts` is the Cloudflare implementation and the in-memory
 * seed / test fakes are the others.
 *
 * One spelling of "the ORDERS store binding is not usable". Three sites answer
 * 503 with this string — twice in the download route (binding missing, and
 * get threw) and once in the Stripe webhook (binding missing). Same
 * deploy-time fact, same status, same body; the string is what an operator
 * greps for when a paid download 503s. A reworded literal in one site would
 * make the three indistinguishable in the logs. Only a missing or throwing
 * binding may produce it — the webhook's bare catch must never answer with
 * this string for an unrelated throw.
 *
 * The two routes answer with different headers and that asymmetry is
 * deliberate: download is a private asset route and wraps the body in
 * NO_STORE_HEADERS, while the webhook returns no headers. So these are two
 * plain constants rather than a shared response builder — the string and the
 * status are the shared facts, the headers stay the caller's choice.
 *
 * Stays free of `next/server`, like json-body.ts and prodigi-config.ts.
 */

import type { OrderRecord, OrderStatus } from "../../domain/ordering/order-decision";
import type {
  DownloadTokenIndex,
  DownloadTokenRecord,
} from "../../application/fulfillment/download-token";

export const ORDERS_STORE_UNAVAILABLE_ERROR = "orders-store-unavailable";

export const ORDERS_STORE_UNAVAILABLE_STATUS = 503;

/**
 * Default page size for `listOrders` when the caller omits `limit`. Named so
 * the reconciler, the operator script, and any future caller share one bound
 * rather than each picking a number that then drifts.
 */
export const ORDERS_LIST_DEFAULT_LIMIT = 100;

/**
 * Hard ceiling on `listOrders`. A caller that asks for more is clamped, not
 * refused — an operator view that overshoots should still return something
 * rather than error, and the reconciler's batch is well under this.
 */
export const ORDERS_LIST_MAX_LIMIT = 500;

export type OrderStatusFilter = {
  /** Exact statuses. Omit for "every status". */
  status?: readonly OrderStatus[];
  /**
   * The reconciler's predicate: paid-unfulfilled AND terminal = 0, in one
   * indexed query. Not expressible as `status: ["paid-unfulfilled"]` alone,
   * because a non-retryable failure is also paid-unfulfilled and must never be
   * retried by the reconciler.
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

  /**
   * The first write for a session, and every write of a brand-new order.
   * Unconditional on purpose: there is nothing to compare against yet.
   * Creates the row with attempts = 1.
   */
  putOrder(record: OrderRecord): Promise<void>;

  /**
   * Optimistic lock. Succeeds only while the row's `attempts` column is still
   * exactly `fromAttempts`; writes `record` and bumps attempts to
   * fromAttempts + 1 in the same statement.
   *
   * Returns false when the row moved underneath — which is how the losing side
   * of a duplicate delivery identifies itself, so this MUST be a single
   * `UPDATE ... WHERE session_id = ? AND attempts = ?` and the boolean must
   * come from the row count, never from a read the caller did earlier.
   *
   * The lock is only as good as the `fromAttempts` the caller just read: two
   * racers that both read `n` both submit `fromAttempts: n`; one UPDATE
   * matches and the other matches zero rows. That is enough for the
   * acceptance criterion (two concurrent redeliveries place one Prodigi
   * order) because the claim runs *before* the Prodigi call.
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

  /** Token record plus its reverse index, written in one `db.batch()`. */
  putDownloadToken(
    record: DownloadTokenRecord,
    index: DownloadTokenIndex,
  ): Promise<void>;

  /** The reverse-index value for a session, or null. */
  findDownloadToken(sessionId: string): Promise<string | null>;

  /**
   * Spend one download and return the post-spend record.
   *
   * ONE statement:
   *   UPDATE download_tokens SET downloads = downloads - 1
   *    WHERE token = ? AND expires_at > ? AND downloads > 0
   *   RETURNING ...
   * This is what makes the counter exact; the previous KV get-then-put raced.
   *
   * When it changes no rows, a single follow-up SELECT classifies the refusal
   * so the route can keep its current status codes:
   *   { kind: "missing" } -> 404 invalid-token
   *   { kind: "expired" } -> 410 download-expired
   *   { kind: "exhausted" } -> 410 download-limit-reached
   */
  spendDownloadToken(
    token: string,
    nowMs: number,
  ): Promise<
    | { kind: "spent"; record: DownloadTokenRecord }
    | { kind: "missing" | "expired" | "exhausted" }
  >;

  /**
   * Claim a Prodigi CloudEvent id for callback dedupe (#117).
   *
   * Returns true when this event id is new — a single
   * `INSERT … ON CONFLICT DO NOTHING` whose `meta.changes > 0` is the boolean,
   * bound parameters only. A false return means the id was already claimed, so
   * the webhook answers 200 `{ duplicate: true }` without re-fetching state or
   * re-sending mail. The claim is ours alone: Prodigi signs nothing.
   */
  claimProdigiCallback(eventId: string): Promise<boolean>;
};

/**
 * Clamp a caller-supplied list limit into the named default/max window.
 *
 * Exported so the D1 implementation, the in-memory seed, and the test fake
 * cannot each invent a different clamp and then disagree about how many rows
 * an operator asked for.
 */
export function clampOrderListLimit(limit: number | undefined): number {
  if (limit === undefined) return ORDERS_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return ORDERS_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), ORDERS_LIST_MAX_LIMIT);
}

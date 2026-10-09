/**
 * Download tokens: the only thing that now grants a master file (#111 / #116).
 *
 * `/api/download` answers to a token rather than to the Checkout Session id,
 * because the id identifies the order while a download is a credential, and
 * those have different lifetimes: the id travels in the success URL (history,
 * `Referer`, screenshots, support emails) and names no expiry or count of its
 * own. Both jobs are served — the id still resolves the order record, the
 * token still grants the file — but only the token is spent when used.
 *
 * A token is 128 bits of `crypto.getRandomValues`, stored in the orders D1
 * database as a `download_tokens` row: `{ v, sessionId, expiresAt, remaining }`
 * in the `record` column, with `expires_at` and `downloads` as indexed
 * columns. The reverse index (`index_record`, keyed by session_id) is what the
 * success page and the (future, #117) email read to find the token for an
 * order they already know by session.
 *
 * The download counter is exact. `spendDownloadToken` is a single
 * `UPDATE ... WHERE token = ? AND expires_at > ? AND downloads > 0` that
 * decrements and returns the row; two concurrent spends cannot both succeed
 * on the last download because the loser matches zero rows. There is no second
 * expiry to disagree with: D1 has no TTL sidecar the way KV's `expirationTtl`
 * did, so `expires_at` on the row is the only clock the read path and the
 * spend statement consult.
 *
 * Types, constants, and pure helpers (`DownloadTokenRecord`, `DownloadTokenIndex`,
 * `DownloadTokenLimits`, `TokenRedeem`, `newDownloadToken`, `isDownloadToken`,
 * `parseDownloadTokenRecord`, `parseDownloadTokenIndex`, `DOWNLOAD_TOKEN_TTL_SECONDS`,
 * `DOWNLOAD_TOKEN_MAX_DOWNLOADS`) moved to `domain/ordering/download-token.ts`.
 * This module owns only the effectful store-interaction functions.
 */

import {
  isDownloadToken,
  newDownloadToken,
  parseDownloadTokenIndex,
} from "../../domain/ordering/download-token";
import type {
  DownloadTokenIndex,
  DownloadTokenLimits,
  DownloadTokenRecord,
  TokenRedeem,
} from "../../domain/ordering/download-token";
import {
  ORDERS_STORE_UNAVAILABLE_ERROR,
  type OrdersStore,
} from "../../domain/ordering/orders-store";

/**
 * Key helpers kept for the migration script and for tests that still name the
 * old KV layout. The live store addresses rows by token / session_id; these
 * strings are not used as D1 keys.
 */
export function downloadTokenKey(token: string): string {
  return `dl:${token}`;
}

/**
 * Reverse-index key helper for the migration script. D1 stores the index as
 * `index_record` on the same download_tokens row.
 */
export function downloadIndexKey(sessionId: string): string {
  return `dls:${sessionId}`;
}

/** The token record for an order, or null when there is not one (yet). */
export async function readDownloadToken(
  store: OrdersStore,
  sessionId: string,
  options: { nowMs?: number } = {},
): Promise<DownloadTokenIndex | null> {
  let raw: string | null;
  try {
    raw = await store.findDownloadToken(sessionId);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const record = parseDownloadTokenIndex(raw);
  if (!record || record.sessionId !== sessionId) return null;
  if (record.expiresAt * 1000 <= (options.nowMs ?? Date.now())) return null;
  return record;
}

/** The download link for an order, or null when there is no usable token. */
export async function downloadLinkForSession(
  store: OrdersStore,
  sessionId: string,
  options: { nowMs?: number } = {},
): Promise<string | null> {
  const record = await readDownloadToken(store, sessionId, options);
  if (!record) return null;
  return `/api/download?token=${encodeURIComponent(record.token)}`;
}

/**
 * The token for an order, minting one if the order has none.
 *
 * Idempotent, and called from both the fulfillment write path and the
 * duplicate path, because a token is only useful if it survives a webhook that
 * stored the order and then failed for some other reason: with the duplicate
 * branch minting too, a redelivery repairs the missing token instead of hitting
 * "duplicate, already handled" and leaving the customer with no way in.
 */
export async function ensureDownloadToken(
  input: {
    store: OrdersStore;
    sessionId: string;
    limits: DownloadTokenLimits;
    nowMs?: number;
  },
): Promise<DownloadTokenIndex | null> {
  const existing = await readDownloadToken(input.store, input.sessionId, input);
  if (existing) return existing;

  const nowMs = input.nowMs ?? Date.now();
  const token = newDownloadToken();
  const record: DownloadTokenRecord = {
    v: 1,
    sessionId: input.sessionId,
    expiresAt: Math.floor(nowMs / 1000) + input.limits.ttlSeconds,
    remaining: input.limits.maxDownloads,
  };
  const index: DownloadTokenIndex = { ...record, token };
  try {
    await input.store.putDownloadToken(record, index);
  } catch {
    return null;
  }
  return index;
}

/**
 * Spend one download from a token and return the session it names.
 *
 * Order of checks: the store's atomic spend classifies missing / expired /
 * exhausted; the route keeps the same status codes it had under KV. Expiry
 * before counter remains the customer-facing priority when both are true —
 * `spendDownloadToken` encodes that in the WHERE clause and the follow-up
 * SELECT.
 *
 * `remaining` is decremented *before* the caller reads the order record at all,
 * so the spend is not conditional on the request succeeding: an order that then
 * answers 202/403/409/500, or a stream that dies mid-flight, still cost a
 * download. That is an artefact of the only ordering available — a streamed
 * response cannot be un-sent — and not a feature.
 *
 * Note what this does NOT check: whether the order is still paid. The route runs
 * `resolveDownload` afterwards, and that is the single place a refunded or
 * disputed order is refused — a second copy of that rule here would give two
 * places to disagree about what "revoked" means.
 */
export async function redeemDownloadToken(
  input: {
    store: OrdersStore;
    token: string;
    nowMs?: number;
  },
): Promise<TokenRedeem> {
  if (!isDownloadToken(input.token)) {
    return { ok: false, status: 400, error: "invalid-token" };
  }

  let spent: Awaited<ReturnType<OrdersStore["spendDownloadToken"]>>;
  try {
    spent = await input.store.spendDownloadToken(
      input.token,
      input.nowMs ?? Date.now(),
    );
  } catch {
    return { ok: false, status: 503, error: ORDERS_STORE_UNAVAILABLE_ERROR };
  }

  if (spent.kind === "spent") {
    return { ok: true, record: spent.record, token: input.token };
  }
  if (spent.kind === "missing") {
    return { ok: false, status: 404, error: "invalid-token" };
  }
  if (spent.kind === "expired") {
    return { ok: false, status: 410, error: "download-expired" };
  }
  return { ok: false, status: 410, error: "download-limit-reached" };
}

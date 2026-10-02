/**
 * Download tokens: the only thing that now grants a master file (#111).
 *
 * `/api/download` answers to a token rather than to the Checkout Session id,
 * because the id identifies the order while a download is a credential, and
 * those have different lifetimes: the id travels in the success URL (history,
 * `Referer`, screenshots, support emails) and names no expiry or count of its
 * own. Both jobs are served — the id still resolves the order record, the
 * token still grants the file — but only the token is spent when used.
 *
 * A token is 128 bits of `crypto.getRandomValues`, stored in ORDERS under
 * `dl:<token>` as `{ v, sessionId, expiresAt, remaining }` with a KV
 * `expirationTtl` so the record cannot outlive its own `expiresAt` even if
 * nothing ever reads it again. `dls:<sessionId>` is the reverse index the
 * success page and the (future, #117) email read to find the token for an
 * order they already know by session.
 *
 * The two limits are advisory, and that is deliberate rather than a shortfall:
 * KV has no compare-and-swap, so a customer who opens the link in two tabs can
 * burn two of five. The counter therefore errs toward *serving* — a scraper
 * still burns through five immediately, and a real customer racing their own
 * tabs is never shown an error page for it. Making it exact needs a Durable
 * Object per token, which is heavy infra for a soft abuse limit. The same race
 * is why there is no "claim" marker: it would have the identical
 * read-then-write window plus a stuck-marker failure mode that kills a live
 * token if the process dies between the two writes.
 */

import { isCheckoutSessionId } from "./order-decision";
import { ORDERS_KV_UNAVAILABLE_ERROR } from "./orders-kv";
import type { OrdersKv } from "./fulfillment";

/** Default lifetime of a download token: 30 days from issuance. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Default number of downloads one token grants. */
export const DOWNLOAD_TOKEN_MAX_DOWNLOADS = 5;

/** 128 bits, hex. The length *is* the grammar, so no two spellings pass. */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The public key a token is stored under. */
export function downloadTokenKey(token: string): string {
  return `dl:${token}`;
}

/**
 * The reverse index from an order to its token.
 *
 * A separate key rather than a field on the order record: the record's parser
 * is a closed v1 shape, and widening it for a credential would mean every
 * existing record becomes unreadable until it is rewritten.
 */
export function downloadIndexKey(sessionId: string): string {
  return `dls:${sessionId}`;
}

/** 128 bits from the platform CSPRNG, hex. */
export function newDownloadToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function isDownloadToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export type DownloadTokenRecord = {
  v: 1;
  sessionId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Downloads still available. Advisory — see the module docblock. */
  remaining: number;
};

/**
 * Parse a stored token record, or null.
 *
 * `sessionId` is validated here rather than trusted, because it becomes the key
 * of the order read that follows: a token record naming an arbitrary session
 * would otherwise be a way to ask for any order's file.
 */
export function parseDownloadTokenRecord(raw: string): DownloadTokenRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseDownloadTokenRecordValue(value);
}

/**
 * The shape check, on an already-parsed value.
 *
 * Split from `parseDownloadTokenRecord` so the index parser can validate the
 * same fields without a second `JSON.parse` it would only ever succeed at.
 */
function parseDownloadTokenRecordValue(value: unknown): DownloadTokenRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return null;
  if (typeof row.sessionId !== "string" || !isCheckoutSessionId(row.sessionId)) {
    return null;
  }
  if (typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt)) {
    return null;
  }
  if (typeof row.remaining !== "number" || !Number.isInteger(row.remaining)) {
    return null;
  }
  return {
    v: 1,
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    // Negative would mean a record written by something that decremented past
    // zero; clamping here keeps the counter a number the route can compare.
    remaining: Math.max(0, row.remaining),
  };
}

/**
 * The index value: the record plus the token itself.
 *
 * The token is the *key* of `dl:<token>` and not part of that value, so a
 * lookup starting from a session id — the success page, or the #117 email —
 * could not recover it without scanning KV. Carrying it in the index is what
 * makes "give this order its download link" a single get.
 */
export type DownloadTokenIndex = DownloadTokenRecord & { token: string };

/**
 * Parse the index value: the record plus the token, in one pass.
 *
 * Deliberately not "parse the record, then parse again for `token`": the second
 * `JSON.parse` would need its own catch for a failure that cannot happen, which
 * is dead code the coverage floors rightly flag — and which invites a future
 * edit to handle two parses as if they could disagree.
 */
function parseDownloadTokenIndex(raw: string): DownloadTokenIndex | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parseDownloadTokenRecordValue(value);
  if (!record) return null;
  const token = (value as { token?: unknown }).token;
  if (typeof token !== "string" || !isDownloadToken(token)) return null;
  return { ...record, token };
}

export type DownloadTokenLimits = {
  ttlSeconds: number;
  maxDownloads: number;
};

/** The token record for an order, or null when there is not one (yet). */
export async function readDownloadToken(
  kv: OrdersKv,
  sessionId: string,
  options: { nowMs?: number } = {},
): Promise<DownloadTokenIndex | null> {
  let raw: string | null;
  try {
    raw = await kv.get(downloadIndexKey(sessionId));
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
  kv: OrdersKv,
  sessionId: string,
  options: { nowMs?: number } = {},
): Promise<string | null> {
  const record = await readDownloadToken(kv, sessionId, options);
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
    kv: OrdersKv;
    sessionId: string;
    limits: DownloadTokenLimits;
    nowMs?: number;
  },
): Promise<DownloadTokenIndex | null> {
  const existing = await readDownloadToken(input.kv, input.sessionId, input);
  if (existing) return existing;

  const nowMs = input.nowMs ?? Date.now();
  const token = newDownloadToken();
  const record: DownloadTokenRecord = {
    v: 1,
    sessionId: input.sessionId,
    expiresAt: Math.floor(nowMs / 1000) + input.limits.ttlSeconds,
    remaining: input.limits.maxDownloads,
  };
  // KV's own TTL is one second under `expiresAt`, so the record cannot still be
  // readable in the window between the two expiries. Belt and braces: the read
  // path checks `expiresAt` anyway.
  const expirationTtl = Math.max(1, input.limits.ttlSeconds - 1);
  try {
    // Token first: an index pointing at a token that was never written would be
    // a link that resolves to nothing, which reads as a broken download rather
    // than as "no token yet".
    await input.kv.put(downloadTokenKey(token), JSON.stringify(record), {
      expirationTtl,
    });
    await input.kv.put(
      downloadIndexKey(input.sessionId),
      JSON.stringify({ ...record, token }),
      { expirationTtl },
    );
  } catch {
    return null;
  }
  return { ...record, token };
}

export type TokenRedeem =
  | { ok: true; record: DownloadTokenRecord; token: string }
  | { ok: false; status: number; error: string };

/**
 * Spend one download from a token and return the session it names.
 *
 * Order of checks: expiry before counter, then the counter. A token past its
 * lifetime is refused even if it still has downloads left, because "expired"
 * is the answer the customer can act on and a spent count is not.
 *
 * `remaining` is decremented *before* the caller reads the order record at all,
 * so the spend is not conditional on the request succeeding: an order that then
 * answers 202/403/409/500, or a stream that dies mid-flight, still cost a
 * download. That is an artefact of the only ordering available — a streamed
 * response cannot be un-sent — and not a feature. It is safe here for the same
 * reason the race above is: it errs toward serving a customer who is owed the
 * file, and the cases that reach it (revoked order, order not yet stored) are
 * ones where the counter is not what is protecting anything.
 *
 * Note what this does NOT check: whether the order is still paid. The route runs
 * `resolveDownload` afterwards, and that is the single place a refunded or
 * disputed order is refused — a second copy of that rule here would give two
 * places to disagree about what "revoked" means.
 */
export async function redeemDownloadToken(
  input: {
    kv: OrdersKv;
    token: string;
    nowMs?: number;
  },
): Promise<TokenRedeem> {
  if (!isDownloadToken(input.token)) {
    return { ok: false, status: 400, error: "invalid-token" };
  }

  let raw: string | null;
  try {
    raw = await input.kv.get(downloadTokenKey(input.token));
  } catch {
    return { ok: false, status: 503, error: ORDERS_KV_UNAVAILABLE_ERROR };
  }
  if (raw === null) {
    return { ok: false, status: 404, error: "invalid-token" };
  }

  const record = parseDownloadTokenRecord(raw);
  if (!record) {
    return { ok: false, status: 404, error: "invalid-token" };
  }
  if (record.expiresAt * 1000 <= (input.nowMs ?? Date.now())) {
    return { ok: false, status: 410, error: "download-expired" };
  }
  if (record.remaining <= 0) {
    return { ok: false, status: 410, error: "download-limit-reached" };
  }

  const spent: DownloadTokenRecord = { ...record, remaining: record.remaining - 1 };
  const ttlSeconds = Math.max(
    1,
    Math.ceil((spent.expiresAt * 1000 - (input.nowMs ?? Date.now())) / 1000),
  );
  try {
    // Both keys, because the index is a copy: leaving it with a stale count
    // would make the success page offer a token whose balance is already spent.
    await input.kv.put(downloadTokenKey(input.token), JSON.stringify(spent), {
      expirationTtl: ttlSeconds,
    });
    // The index carries the token itself, so it is rewritten from the token we
    // were just handed rather than from the stored value — writing `spent` alone
    // would drop that field and silently un-link the order.
    await input.kv.put(
      downloadIndexKey(spent.sessionId),
      JSON.stringify({ ...spent, token: input.token }),
      { expirationTtl: ttlSeconds },
    );
  } catch {
    return { ok: false, status: 503, error: ORDERS_KV_UNAVAILABLE_ERROR };
  }

  return { ok: true, record: spent, token: input.token };
}
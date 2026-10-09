/**
 * Download-token types and pure helpers, owned by the domain (#111 / #116).
 *
 * Moved from `application/fulfillment/download-token.ts` so the
 * `orders-store` port (and infra D1/seed implementations) can import the
 * record type without reaching into application. The effectful
 * store/interaction functions stay in `application/fulfillment/download-token.ts`.
 */

import { isCheckoutSessionId } from "./order-decision";

/** Default lifetime of a download token: 30 days from issuance. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Default number of downloads one token grants. */
export const DOWNLOAD_TOKEN_MAX_DOWNLOADS = 5;

/** 128 bits, hex. The length *is* the grammar, so no two spellings pass. */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export type DownloadTokenRecord = {
  v: 1;
  sessionId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Downloads still available. Exact under D1. */
  remaining: number;
};

/**
 * The index value: the record plus the token itself.
 * The token is the primary key of the row and not part of the `record` JSON,
 * so a lookup starting from a session id needs the index to recover it.
 */
export type DownloadTokenIndex = DownloadTokenRecord & { token: string };

export type DownloadTokenLimits = {
  ttlSeconds: number;
  maxDownloads: number;
};

export type TokenRedeem =
  | { ok: true; record: DownloadTokenRecord; token: string }
  | { ok: false; status: number; error: string };

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

/**
 * Parse a stored token record, or null.
 * `sessionId` is validated here rather than trusted, because it becomes the key
 * of the order read that follows.
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
    remaining: Math.max(0, row.remaining),
  };
}

/**
 * Parse the index value: the record plus the token, in one pass.
 */
export function parseDownloadTokenIndex(raw: string): DownloadTokenIndex | null {
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

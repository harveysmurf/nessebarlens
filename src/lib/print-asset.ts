/**
 * Prodigi print-asset delivery (Phase 3 B).
 * Streams the private master JPEG via a Worker HMAC URL — no public path,
 * no ingest byte-copy. Distinct from /api/download (not digital-gated).
 */

import { masterKeyForSlug } from "./master-key";
import { siteUrl } from "./stripe";

/** Prodigi may re-fetch during fulfillment; start at 7d, tighten after a live order. */
export const PRINT_ASSET_TTL_SECONDS = 7 * 24 * 60 * 60;

type MasterObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
};

type MastersBucket = {
  get(key: string): Promise<MasterObject | null>;
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PrintAssetVerifyOk = { ok: true; slug: string };
export type PrintAssetVerifyErr = {
  ok: false;
  status: number;
  error: string;
};
export type PrintAssetVerifyResult = PrintAssetVerifyOk | PrintAssetVerifyErr;

export type PrintAssetStream =
  | { kind: "json"; status: number; body: Record<string, string> }
  | {
      kind: "stream";
      body: ReadableStream<Uint8Array>;
      contentType: "image/jpeg";
      size: number;
    };

/** HMAC secret for /api/print-asset. Min 32 chars; unset → placeholder fallback. */
export function printAssetSecret(
  env: Record<string, unknown> = process.env,
): string | null {
  const raw = env.PRINT_ASSET_HMAC_SECRET;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length >= 32 ? trimmed : null;
}

export function isPhotoSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * Signed Worker URL for Prodigi. Returns null if secret unset or slug invalid
 * (caller falls back to placeholder).
 */
export async function signPrintAssetUrl(
  slug: string,
  options: {
    secret?: string | null;
    nowMs?: number;
    ttlSeconds?: number;
    baseUrl?: string;
  } = {},
): Promise<string | null> {
  if (!isPhotoSlug(slug) || !masterKeyForSlug(slug)) return null;
  const secret = options.secret === undefined ? printAssetSecret() : options.secret;
  if (!secret) return null;

  const nowMs = options.nowMs ?? Date.now();
  const ttl = options.ttlSeconds ?? PRINT_ASSET_TTL_SECONDS;
  const exp = Math.floor(nowMs / 1000) + ttl;
  const sig = await hmacSha256Hex(signingPayload(slug, exp), secret);
  const base = (options.baseUrl ?? siteUrl()).replace(/\/$/, "");
  const params = new URLSearchParams({
    slug,
    exp: String(exp),
    sig,
  });
  return `${base}/api/print-asset?${params.toString()}`;
}

export async function verifyPrintAssetRequest(
  slug: string,
  expRaw: string,
  sig: string,
  options: { secret?: string | null; nowMs?: number } = {},
): Promise<PrintAssetVerifyResult> {
  const secret = options.secret === undefined ? printAssetSecret() : options.secret;
  if (!secret) {
    return { ok: false, status: 503, error: "print-asset-unavailable" };
  }
  if (!isPhotoSlug(slug) || !masterKeyForSlug(slug)) {
    return { ok: false, status: 400, error: "invalid-slug" };
  }
  if (!/^\d{1,12}$/.test(expRaw)) {
    return { ok: false, status: 400, error: "invalid-exp" };
  }
  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return { ok: false, status: 400, error: "invalid-sig" };
  }

  const exp = Number(expRaw);
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (exp < nowSec) {
    return { ok: false, status: 401, error: "expired" };
  }
  // Reject absurd future expiry (clock skew + max TTL + small pad).
  if (exp > nowSec + PRINT_ASSET_TTL_SECONDS + 300) {
    return { ok: false, status: 400, error: "invalid-exp" };
  }

  const expected = await hmacSha256Hex(signingPayload(slug, exp), secret);
  if (!timingSafeEqualHex(expected, sig.toLowerCase())) {
    return { ok: false, status: 401, error: "bad-signature" };
  }
  return { ok: true, slug };
}

/**
 * Stream master bytes for a verified slug. Never accepts a raw R2 key —
 * always resolves via masterKeyForSlug so only catalog masters are served.
 */
export async function resolvePrintAssetStream(
  slug: string,
  masters: MastersBucket | undefined,
): Promise<PrintAssetStream> {
  const masterKey = masterKeyForSlug(slug);
  if (!masterKey) {
    return { kind: "json", status: 400, body: { error: "invalid-slug" } };
  }
  // Hard guard: only prints/{slug}.jpg from the catalog — never arbitrary keys.
  if (!masterKey.startsWith("prints/") || !masterKey.endsWith(".jpg")) {
    return { kind: "json", status: 500, body: { error: "bad-master-key" } };
  }
  if (!masters) {
    return { kind: "json", status: 503, body: { error: "masters-unavailable" } };
  }

  let object: MasterObject | null;
  try {
    object = await masters.get(masterKey);
  } catch {
    return { kind: "json", status: 503, body: { error: "masters-unavailable" } };
  }
  if (!object) {
    return { kind: "json", status: 404, body: { error: "master-not-found" } };
  }

  return {
    kind: "stream",
    body: object.body,
    contentType: "image/jpeg",
    size: object.size,
  };
}

function signingPayload(slug: string, exp: number): string {
  return `v1.${slug}.${exp}`;
}

async function hmacSha256Hex(content: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(content));
  const bytes = new Uint8Array(signature);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function timingSafeEqualHex(expected: string, actual: string): boolean {
  const a = expected.toLowerCase();
  const b = actual.toLowerCase();
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

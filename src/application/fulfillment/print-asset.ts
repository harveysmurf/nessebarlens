/**
 * Prodigi print-asset delivery (Phase 3 B).
 * Streams the private master JPEG via a Worker HMAC URL — no public path,
 * no ingest byte-copy. Distinct from /api/download (not digital-gated).
 */

import { PHOTO_SLUG_PATTERN } from "../../domain/catalog/derivative-ladder";
import {
  masterKeyForSlug,
  readMasterObject,
  type MastersBucket,
} from "../../domain/catalog/master-key";
import {
  HEX_64_PATTERN,
  hmacSha256Hex,
  timingSafeEqualHex,
} from "../../domain/pricing/crypto-hex";
import { stripTrailingSlashes } from "../../infrastructure/config/env";
import {
  printAssetSecret,
  siteUrl,
  usablePrintAssetSecret,
} from "../../infrastructure/config/config";

/** Prodigi may re-fetch during fulfillment; start at 7d, tighten after a live order. */
export const PRINT_ASSET_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Slack on top of PRINT_ASSET_TTL_SECONDS when rejecting an absurd future
 * `exp`, for two reasons that are not the TTL's: the verifying Worker's clock
 * can run behind the signing one, and the URL may have been generated just
 * before the current second rolled over. Deliberately NOT folded into the TTL
 * — raising the TTL must not silently widen the skew allowance a verifier
 * accepts, which is a separate security decision.
 */
const CLOCK_SKEW_PAD_SECONDS = 300;

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

/**
 * The secret the signer and the verifier must agree on.
 *
 * Both paths resolve it identically on purpose: an explicit `undefined` means
 * "use this deployment's configured secret", while an explicit null or string
 * is taken as given (and still run through usablePrintAssetSecret, so a
 * whitespace-only override is rejected the same way a whitespace-only binding
 * is). If the two
 * ever picked differently, URLs would be signed with one key and verified with
 * another, and every legitimate download would 401.
 */
function resolveSecret(secret: string | null | undefined): string | null {
  return secret === undefined ? printAssetSecret() : usablePrintAssetSecret(secret);
}

/**
 * Whether this deployment can actually produce a signed master URL for `slug`.
 *
 * Used as a pre-payment guard: /api/checkout refuses to create a Stripe
 * session when this is false, so a physical order can never be paid for and
 * then fulfilled from the public placeholder.
 *
 * It deliberately asks signPrintAssetUrl rather than testing the secret
 * directly, so the check answers the question that actually matters — "would
 * the order path be able to sign this?" — instead of a proxy for it that could
 * drift from the signer.
 */
export async function canSignMasterAsset(slug: string): Promise<boolean> {
  return (await signPrintAssetUrl(slug)) !== null;
}

export function isPhotoSlug(value: string): boolean {
  return PHOTO_SLUG_PATTERN.test(value);
}

/**
 * Signed Worker URL for Prodigi. Returns null if the secret is unset or the slug
 * is invalid.
 *
 * There is no placeholder fallback: since #245 the asset URL is always this
 * signed URL (or the null above). createProdigiOrder fails closed when signing
 * returns null, and /api/checkout calls canSignMasterAsset() and answers 503
 * before creating a Stripe session, so no paid order is ever fulfilled from a
 * public stand-in.
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
  const secret = resolveSecret(options.secret);
  if (!secret) return null;

  const nowMs = options.nowMs ?? Date.now();
  const ttl = options.ttlSeconds ?? PRINT_ASSET_TTL_SECONDS;
  const exp = Math.floor(nowMs / 1000) + ttl;
  const sig = await hmacSha256Hex(signingPayload(slug, exp), secret);
  // options.baseUrl is caller-supplied, so it still needs stripping; siteUrl()
  // is already slash-free.
  const base = stripTrailingSlashes(options.baseUrl ?? siteUrl());
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
  const secret = resolveSecret(options.secret);
  if (!secret) {
    return { ok: false, status: 503, error: "print-asset-unavailable" };
  }
  if (!isPhotoSlug(slug) || !masterKeyForSlug(slug)) {
    return { ok: false, status: 400, error: "invalid-slug" };
  }
  if (!/^\d{1,12}$/.test(expRaw)) {
    return { ok: false, status: 400, error: "invalid-exp" };
  }
  if (!HEX_64_PATTERN.test(sig)) {
    return { ok: false, status: 400, error: "invalid-sig" };
  }

  const exp = Number(expRaw);
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (exp < nowSec) {
    return { ok: false, status: 401, error: "expired" };
  }
  // Reject absurd future expiry: max TTL, plus the skew allowance.
  if (exp > nowSec + PRINT_ASSET_TTL_SECONDS + CLOCK_SKEW_PAD_SECONDS) {
    return { ok: false, status: 400, error: "invalid-exp" };
  }

  const expected = await hmacSha256Hex(signingPayload(slug, exp), secret);
  if (!timingSafeEqualHex(expected, sig)) {
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
  // The single gate: masterKeyForSlug returns null unless the slug is in the
  // catalog and its imageKey is a valid prints/{slug}.jpg master. A second
  // isMasterKey() check here was a re-run of the same predicate one call
  // earlier — provably unreachable, and a dead 500 in a security path is worse
  // than no branch at all.
  const masterKey = masterKeyForSlug(slug);
  if (!masterKey) {
    return { kind: "json", status: 400, body: { error: "invalid-slug" } };
  }
  const read = await readMasterObject(masterKey, masters);
  if (!read.ok) {
    return { kind: "json", status: read.status, body: { error: read.error } };
  }
  const object = read.object;

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

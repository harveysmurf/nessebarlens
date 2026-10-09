/**
 * The configured `AssetUrlSigner` adapter (#3, DDD).
 *
 * This is the one place that reads `printAssetSecret()` and `siteUrl()` from
 * `infrastructure/config/config` for the print-asset signing path. The application
 * depends on the `AssetUrlSigner` interface from `domain/ordering/asset-url-signer`,
 * never on this module directly — routes get an instance via `container.assetUrlSigner()`.
 *
 * The HMAC scheme (slug + exp, v1 payload format) is domain policy and lives
 * alongside the port interface in `domain/ordering/asset-url-signer.ts`; the
 * constants and crypto helpers are imported from domain here.
 */

import { PHOTO_SLUG_PATTERN } from "../../domain/catalog/derivative-ladder";
import { masterKeyForSlug } from "../../domain/catalog/master-key";
import {
  HEX_64_PATTERN,
  hmacSha256Hex,
  timingSafeEqualHex,
} from "../../domain/pricing/crypto-hex";
import { stripTrailingSlashes } from "../../domain/pricing/url-patterns";
import { printAssetSecret, siteUrl } from "../config/config";
import { usablePrintAssetSecret } from "../../domain/ordering/print-asset";
import {
  PRINT_ASSET_TTL_SECONDS,
  type AssetSignerOptions,
  type AssetSignerVerifyOptions,
  type AssetUrlSigner,
  type PrintAssetVerifyResult,
} from "../../domain/ordering/asset-url-signer";

/**
 * Slack on top of PRINT_ASSET_TTL_SECONDS when rejecting an absurd future
 * `exp`, for two reasons that are not the TTL's: the verifying Worker's clock
 * can run behind the signing one, and the URL may have been generated just
 * before the current second rolled over. Deliberately NOT folded into the TTL
 * — raising the TTL must not silently widen the skew allowance a verifier
 * accepts, which is a separate security decision.
 */
const CLOCK_SKEW = 300;

/** Prodigi may re-fetch during fulfillment; start at 7d, tighten after a live order. */

const SIGNING_V1 = (slug: string, exp: number): string => `v1.${slug}.${exp}`;

/**
 * The secret the signer and the verifier must agree on.
 *
 * Both paths resolve it identically on purpose: an explicit `undefined` means
 * "use this deployment's configured secret", while an explicit null or string
 * is taken as given (and still run through usablePrintAssetSecret, so a
 * whitespace-only override is rejected the same way a whitespace-only binding
 * is).
 */
function resolveSecret(secret: string | null | undefined): string | null {
  return secret === undefined ? printAssetSecret() : usablePrintAssetSecret(secret);
}

export function isPhotoSlug(value: string): boolean {
  return PHOTO_SLUG_PATTERN.test(value);
}

/**
 * The Prodigi-backed asset URL signer. Reads the HMAC secret and site origin
 * from infrastructure config; all crypto and URL logic is domain policy.
 */
export class ConfiguredAssetUrlSigner implements AssetUrlSigner {
  async sign(
    slug: string,
    options: AssetSignerOptions = {},
  ): Promise<string | null> {
    if (!isPhotoSlug(slug) || !masterKeyForSlug(slug)) return null;
    const secret = resolveSecret(options.secret);
    if (!secret) return null;

    const nowMs = options.nowMs ?? Date.now();
    const ttl = options.ttlSeconds ?? PRINT_ASSET_TTL_SECONDS;
    const exp = Math.floor(nowMs / 1000) + ttl;
    const sig = await hmacSha256Hex(SIGNING_V1(slug, exp), secret);
    const base = stripTrailingSlashes(options.baseUrl ?? siteUrl());
    const params = new URLSearchParams({
      slug,
      exp: String(exp),
      sig,
    });
    return `${base}/api/print-asset?${params.toString()}`;
  }

  async verify(
    slug: string,
    expRaw: string,
    sig: string,
    options: AssetSignerVerifyOptions = {},
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
    if (exp > nowSec + PRINT_ASSET_TTL_SECONDS + CLOCK_SKEW) {
      return { ok: false, status: 400, error: "invalid-exp" };
    }

    const expected = await hmacSha256Hex(SIGNING_V1(slug, exp), secret);
    if (!timingSafeEqualHex(expected, sig)) {
      return { ok: false, status: 401, error: "bad-signature" };
    }
    return { ok: true, slug };
  }
}

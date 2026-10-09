/**
 * Port for signing and verifying HMAC-protected print-asset URLs.
 *
 * The application depends on this interface; infrastructure provides the impl
 * (`infrastructure/print-asset/asset-url-signer.ts`) which reads the HMAC secret
 * and site URL from config. This avoids the application→infrastructure dependency
 * that `signPrintAssetUrl` originally had when it called `printAssetSecret()` from
 * `infrastructure/config/config` directly.
 *
 * The signing scheme is our own (HMAC + slug + expiry), not vendor-specific —
 * Prodigi is the consumer, not the author of the URL.
 */

/**
 * Default lifetime of a signed print-asset URL: 7 days.
 *
 * Prodigi may re-fetch during fulfillment; 7d is the floor, tighten after a
 * live order. Never folded into CLOCK_SKEW_PAD_SECONDS below — raising the TTL
 * must not silently widen the skew a verifier accepts.
 */
export const PRINT_ASSET_TTL_SECONDS = 7 * 24 * 60 * 60;

export type PrintAssetVerifyOk = { ok: true; slug: string };
export type PrintAssetVerifyErr = {
  ok: false;
  status: number;
  error: string;
};
export type PrintAssetVerifyResult = PrintAssetVerifyOk | PrintAssetVerifyErr;

export type AssetSignerOptions = {
  /**
   * Explicit secret override. Undefined = use the deployment's configured secret.
   * null/string = use this value (still validated by usablePrintAssetSecret).
   */
  secret?: string | null;
  nowMs?: number;
  ttlSeconds?: number;
  baseUrl?: string;
};

export type AssetSignerVerifyOptions = {
  secret?: string | null;
  nowMs?: number;
};

/**
 * The sign/verify surface the application calls. The implementation lives in
 * infrastructure and reads configuration there.
 */
export interface AssetUrlSigner {
  /**
   * Signed Worker URL for `slug`, or null if signing is not possible.
   *
   * Returns null when the secret is unset or the slug is invalid — the caller
   * decides what to do (fail closed, 503, etc.). There is no placeholder URL:
   * the URL is either this signed URL or null.
   */
  sign: (slug: string, options?: AssetSignerOptions) => Promise<string | null>;

  /**
   * Verify a signed print-asset URL request.
   *
   * `expRaw` is the raw string from the URL query parameter — validated here so
   * a malformed exp answers 400 before the HMAC is computed.
   */
  verify: (
    slug: string,
    expRaw: string,
    sig: string,
    options?: AssetSignerVerifyOptions,
  ) => Promise<PrintAssetVerifyResult>;
}

/**
 * Prodigi print-asset delivery (Phase 3 B).
 * Streams the private master JPEG via a Worker HMAC URL — no public path,
 * no ingest byte-copy. Distinct from /api/download (not digital-gated).
 *
 * All signing/verifying is delegated to the `AssetUrlSigner` port from
 * `domain/ordering/asset-url-signer`; the concrete impl lives in
 * `infrastructure/print-asset/asset-url-signer.ts` and is wired at routes
 * via `container.assetUrlSigner()`. This module no longer reads the HMAC
 * secret or the site URL from configuration — the port hides both.
 */

import { PHOTO_SLUG_PATTERN } from "../../domain/catalog/derivative-ladder";
import {
  printAssetKeyForSlug,
  readMasterObject,
  type MastersBucket,
} from "../../domain/catalog/master-key";
import type {
  AssetSignerOptions,
  AssetSignerVerifyOptions,
  AssetUrlSigner,
  PrintAssetVerifyResult,
} from "../../domain/ordering/asset-url-signer";

export type PrintAssetStream =
  | { kind: "json"; status: number; body: Record<string, string> }
  | {
      kind: "stream";
      body: ReadableStream<Uint8Array>;
      contentType: "image/jpeg";
      size: number;
    };

export function isPhotoSlug(value: string): boolean {
  return PHOTO_SLUG_PATTERN.test(value);
}

/**
 * Whether this deployment can actually serve a print asset for `slug`.
 *
 * Used as a pre-payment guard: /api/checkout refuses to create a Stripe
 * session when this is false, so a physical order can never be paid for and
 * then fulfilled from the unrotated master or the public placeholder.
 *
 * Two conditions, both required. `printAssetKeyForSlug` answers the catalog
 * half — the photo must carry a `printAsset`, because that is the only file
 * `/api/print-asset` will ever stream (#307); a null means there is nothing to
 * serve, so the order must be refused. `signer.sign` answers the configuration
 * half — the deployment must hold a usable HMAC secret and site origin. Both
 * are asked, because either being absent makes the order unserviceable.
 */
export async function canSignMasterAsset(
  slug: string,
  signer: AssetUrlSigner,
): Promise<boolean> {
  if (printAssetKeyForSlug(slug) === null) return false;
  return (await signer.sign(slug)) !== null;
}

/**
 * Signed Worker URL for Prodigi. Returns null if the secret is unset or the slug
 * is invalid.
 *
 * Delegates to the `AssetUrlSigner` port. There is no placeholder fallback:
 * since #245 the asset URL is always this signed URL (or the null above).
 * `fulfillment.ts` fail-closes on a null before calling `createProdigiOrder`.
 */
export async function signPrintAssetUrl(
  slug: string,
  signer: AssetUrlSigner,
  options: AssetSignerOptions = {},
): Promise<string | null> {
  return signer.sign(slug, options);
}

/**
 * Verifies a signed print-asset URL request. Delegates to the
 * `AssetUrlSigner` port; the caller supplies the signer and any secret
 * override.
 */
export async function verifyPrintAssetRequest(
  slug: string,
  expRaw: string,
  sig: string,
  signer: AssetUrlSigner,
  options: AssetSignerVerifyOptions = {},
): Promise<PrintAssetVerifyResult> {
  return signer.verify(slug, expRaw, sig, options);
}

/** The 503 shape both missing-asset paths answer with. */
function printAssetUnavailable(
  slug: string,
): Extract<PrintAssetStream, { kind: "json" }> {
  console.error(JSON.stringify({ event: "print-asset.missing", slug }));
  return { kind: "json", status: 503, body: { error: "print-asset-unavailable" } };
}

/**
 * Stream the print asset for a verified slug — the portrait, sRGB, EXIF-free
 * file Prodigi receives (#307). Resolves the key through `printAssetKeyForSlug`,
 * never `masterKeyForSlug`, so a missing asset is a 503 the caller (Prodigi)
 * retries rather than a silent fallback to the unrotated master that #307 exists
 * to remove.
 */
export async function resolvePrintAssetStream(
  slug: string,
  masters: MastersBucket | undefined,
): Promise<PrintAssetStream> {
  // A slug that is not valid grammar is a caller bug, not a retryable miss:
  // 400, so Prodigi does not retry a request that can never succeed.
  if (!isPhotoSlug(slug)) {
    return { kind: "json", status: 400, body: { error: "invalid-slug" } };
  }
  const printKey = printAssetKeyForSlug(slug);
  if (!printKey) {
    // A catalog photo without a print asset, or a slug not in the catalog:
    // there is nothing to serve, and the master must not be substituted.
    return printAssetUnavailable(slug);
  }
  const read = await readMasterObject(printKey, masters);
  if (!read.ok) {
    // A missing object is the same fact as a missing key — the print asset is
    // not there — so it is the same retryable 503. A missing bucket or a
    // throwing get() keeps its own error: it is a deployment problem, not an
    // absent asset.
    if (read.error === "master-not-found") return printAssetUnavailable(slug);
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

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
  masterKeyForSlug,
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
 * Whether this deployment can actually produce a signed master URL for `slug`.
 *
 * Used as a pre-payment guard: /api/checkout refuses to create a Stripe
 * session when this is false, so a physical order can never be paid for and
 * then fulfilled from the public placeholder.
 *
 * Delegates to the port's `sign` — the check answers the question that
 * actually matters — "would the order path be able to sign this?" — instead
 * of a proxy for it that could drift from the signer.
 */
export async function canSignMasterAsset(
  slug: string,
  signer: AssetUrlSigner,
): Promise<boolean> {
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

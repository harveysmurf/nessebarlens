import type { R2ObjectBody } from "@cloudflare/workers-types";

import { isMasterKey, isPrintAssetKey, printAssetKeyFromSlug } from "./derivative-ladder";
import { getPhoto } from "./photos";

/**
 * Reading a master key out of the catalog.
 *
 * The slug grammar and the master-key shape live in derivative-ladder.ts,
 * alongside the rung list, because the ingest script loads that module directly
 * and must not have to reach through this one. Nothing is re-exported here for
 * the sake of a shorter import path: a caller that needs `PHOTO_SLUG_PATTERN`
 * asks derivative-ladder, so "which file owns this grammar" keeps exactly one
 * answer.
 */

export function masterKeyForSlug(slug: string): string | null {
  const key = getPhoto(slug)?.imageKey;
  if (typeof key !== "string" || !isMasterKey(key)) return null;
  return key;
}

/**
 * The print asset key for a slug (#307), or null for a slug not in the catalog
 * or for a photo that has no print asset yet. Serving code resolves through
 * this, never through `masterKeyForSlug`, so a missing asset is an error rather
 * than a silent fallback to the unrotated master.
 */
export function printAssetKeyForSlug(slug: string): string | null {
  const photo = getPhoto(slug);
  if (!photo?.printAsset) return null;
  const key = printAssetKeyFromSlug(slug);
  return isPrintAssetKey(key) ? key : null;
}

/**
 * The three fields of a private MASTERS object this code actually reads, named
 * off the real `R2ObjectBody` rather than declared from scratch.
 *
 * Hand-rolling the shape is what caused #109: the invented `contentType`
 * field is not on R2ObjectBody — the real one is
 * `httpMetadata?.contentType` — so the download route's `object.contentType`
 * read was always `undefined` and every master was served as `image/jpeg`.
 * Deriving the field types from the platform's own means a wrong name here is
 * a typecheck error rather than a silent `undefined`.
 *
 * The body stream is the one field re-typed rather than indexed, because R2
 * declares it unparameterised (`ReadableStream<any>`) and both serving paths
 * hand it straight to a `NextResponse`, which wants `ReadableStream<Uint8Array>`.
 */
export type MasterObject = {
  body: ReadableStream<Uint8Array>;
  size: R2ObjectBody["size"];
  httpMetadata: R2ObjectBody["httpMetadata"];
};

/**
 * R2 binding contract: read-only, so get() is the whole surface. The declared
 * return is narrowed to the three fields read above, which a real `R2Bucket`
 * satisfies structurally — its `get` resolves to a superset of this object.
 */
export type MastersBucket = {
  get(key: string): Promise<MasterObject | null>;
};

/**
 * Result of a master read, carrying the HTTP status/error pair the callers
 * were each mapping by hand. The success shape is deliberately left to the
 * caller: /api/download and /api/print-asset build different envelopes.
 */
export type MasterRead =
  | { ok: true; object: MasterObject }
  | {
      ok: false;
      status: 503 | 404;
      error: "masters-unavailable" | "master-not-found";
    };

/**
 * The read + error mapping both master-serving paths share: missing bucket or
 * a throwing get() are a 503, a null object is a 404. Both master-serving
 * paths share these three branches rather than carrying byte-identical
 * copies.
 */
export async function readMasterObject(
  key: string,
  masters: MastersBucket | undefined,
): Promise<MasterRead> {
  if (!masters) {
    return { ok: false, status: 503, error: "masters-unavailable" };
  }

  let object: MasterObject | null;
  try {
    object = await masters.get(key);
  } catch {
    return { ok: false, status: 503, error: "masters-unavailable" };
  }
  if (!object) {
    return { ok: false, status: 404, error: "master-not-found" };
  }
  return { ok: true, object };
}

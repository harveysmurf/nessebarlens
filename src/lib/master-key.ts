import { getPhoto } from "./photos";

/**
 * Photo slugs are lowercase kebab-case; they key the catalog, the derivative
 * paths and the master object keys. One pattern, so a slug that one module
 * accepts cannot be rejected by another.
 *
 * Anchored, so it is a complete-value check — do not interpolate this into
 * another pattern, use SLUG_BODY for that.
 */
export const PHOTO_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The same slug grammar without anchors, for building a longer key pattern. */
const SLUG_BODY = PHOTO_SLUG_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");

/** Shape of a private MASTERS object key. The catalog itself is photos.ts imageKey. */
export const MASTER_KEY_PATTERN = new RegExp(`^prints/${SLUG_BODY}\\.jpg$`);

/** True only for a well-formed `prints/{slug}.jpg` master key. */
export function isMasterKey(key: string): boolean {
  return MASTER_KEY_PATTERN.test(key);
}

export function masterKeyForSlug(slug: string): string | null {
  const key = getPhoto(slug)?.imageKey;
  if (typeof key !== "string" || !isMasterKey(key)) return null;
  return key;
}

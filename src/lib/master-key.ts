import { getPhoto } from "./photos";

/** Shape of a private MASTERS object key. The catalog itself is photos.ts imageKey. */
const MASTER_KEY_PATTERN = /^prints\/[a-z0-9]+(?:-[a-z0-9]+)*\.jpg$/;

export function masterKeyForSlug(slug: string): string | null {
  const key = getPhoto(slug)?.imageKey;
  if (typeof key !== "string" || !MASTER_KEY_PATTERN.test(key)) return null;
  return key;
}

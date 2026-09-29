import { isMasterKey } from "./derivative-ladder";
import { getPhoto } from "./photos";

/**
 * The slug grammar, the master key shape and their readers live in
 * derivative-ladder.ts, which the ingest script loads directly. Re-exported
 * here so the catalog-facing spelling is still `master-key`.
 */
export {
  MASTER_KEY_PATTERN,
  PHOTO_SLUG_PATTERN,
  isMasterKey,
  slugFromMasterKey,
} from "./derivative-ladder";

export function masterKeyForSlug(slug: string): string | null {
  const key = getPhoto(slug)?.imageKey;
  if (typeof key !== "string" || !isMasterKey(key)) return null;
  return key;
}

/**
 * Shape of a private MASTERS object. Owned here so the two readers (the
 * download path and the print-asset path) cannot drift — they used to each
 * declare their own copy of these two types.
 */
export type MasterObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
};

/** R2 binding contract: read-only, so get() is the whole surface. */
export type MastersBucket = {
  get(key: string): Promise<MasterObject | null>;
};

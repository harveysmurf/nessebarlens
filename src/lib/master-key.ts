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
 * a throwing get() are a 503, a null object is a 404. The two paths used to
 * carry byte-identical copies of these three branches.
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

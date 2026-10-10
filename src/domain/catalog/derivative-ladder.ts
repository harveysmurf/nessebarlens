/**
 * The derivative ladder's vocabulary: slugs, object keys, rungs, buckets, and
 * what one ingest run will write.
 *
 * No imports, on purpose. This module is what an ops script outside the Next
 * build can load — scripts/publish-photos.mjs reaches it directly, and a leaf
 * with no imports of its own is one fewer module the loader has to resolve. One
 * leaf keeps the script honest about where its numbers come from: the rung list
 * the site advertises and the rung list that gets generated are the same array,
 * in one file.
 *
 * The URL side of the ladder (src/infrastructure/media/derivatives.ts) needs the environment
 * and therefore cannot live here; it imports from here instead.
 *
 * The publish direction is the other way round: masters arrive as local files
 * in the gitignored `ingest/` folder (scripts/publish-photos.mjs), get
 * written to the private masters bucket as `prints/{slug}.jpg`, and their
 * rungs go to the public web bucket as `{slug}/{hash8}/{width}.{jpg|webp}`.
 * A dropped file is named for the slug it declares, so the plan is decided
 * from file names, pixel widths and the master's content hash alone.
 */

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

/** Where a master lives, and where its rungs go. Never inverted. */
export const MASTERS_BUCKET_NAME = "nessebar-lens-masters";
export const WEB_BUCKET_NAME = "nessebar-lens-web";
/**
 * Staging and PR previews read their own masters bucket (#212), a print-safe
 * downscale rather than the original. `publish-photos` writes this one; only
 * `--promote` (#242) writes MASTERS_BUCKET_NAME.
 */
export const STAGING_MASTERS_BUCKET_NAME = "nessebar-lens-masters-staging";

const MASTER_KEY_PREFIX = "prints/";

/** Shape of a private MASTERS object key. The catalog itself is photos.ts imageKey. */
export const MASTER_KEY_PATTERN = new RegExp(
  `^${MASTER_KEY_PREFIX}${SLUG_BODY}\\.jpg$`,
);

/**
 * Where a photo's print asset lives (#307): the portrait, sRGB, EXIF-free file
 * Prodigi actually receives, distinct from the digital master at `prints/…`.
 * Never inverted — the two keys must not be confused, because a fallback to the
 * master silently brings back the crop #307 exists to remove.
 */
const PRINT_ASSET_KEY_PREFIX = "print-assets/";

/** Shape of a private MASTERS print-asset key. */
export const PRINT_ASSET_KEY_PATTERN = new RegExp(
  `^${PRINT_ASSET_KEY_PREFIX}${SLUG_BODY}\\.jpg$`,
);

/**
 * The rung list, in one place. Adding a rung is a one-line change here and
 * nothing else: the srcSet, the ingest plan and the tests all read it. Kept a
 * literal, ascending, unique and positive, so it cannot be a runtime value the
 * srcSet and the generator could disagree about.
 */
export const WEB_DERIVATIVE_WIDTHS = [400, 750, 1500, 2000] as const;
export type WebDerivativeWidth = (typeof WEB_DERIVATIVE_WIDTHS)[number];

/** Default display source — the middle rung of the ladder. */
export const WEB_DEFAULT_WIDTH: WebDerivativeWidth = 1500;

/** Output formats every rung is written in. No AVIF. */
export const WEB_DERIVATIVE_FORMATS = ["jpg", "webp"] as const;
export type WebDerivativeFormat = (typeof WEB_DERIVATIVE_FORMATS)[number];

/**
 * The one place a web derivative's object key is spelled:
 * `{slug}/{hash8}/{width}.{ext}`. The content hash in the path is what makes
 * the immutable cache header safe — a changed image is always a new URL.
 */
export function webDerivativeKey(
  slug: string,
  hash: string,
  width: number,
  ext: WebDerivativeFormat,
): string {
  return `${slug}/${hash}/${width}.${ext}`;
}

/**
 * The full lowercase SHA-256 of the master's bytes. Global Web Crypto, not
 * `node:crypto`, so this module keeps its no-imports property and the ops
 * scripts stay loadable under plain node.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The cast is the Uint8Array/BufferSource generic mismatch in TS 5.7's
  // typed arrays, not a real widening: this is a view over binary bytes.
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A master's SHA-256 as the catalog stores it: 64 lowercase hex. Owned here so
 * `publish-photos` and `verify-masters` (#243) validate the same grammar, and a
 * different casing cannot slip past one of them.
 */
export const MASTER_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True only for a well-formed `prints/{slug}.jpg` master key. */
export function isMasterKey(key: string): boolean {
  return MASTER_KEY_PATTERN.test(key);
}

/** True only for a well-formed `print-assets/{slug}.jpg` print-asset key. */
export function isPrintAssetKey(key: string): boolean {
  return PRINT_ASSET_KEY_PATTERN.test(key);
}

/** The slug inside a well-formed `prints/{slug}.jpg` key, or null. */
export function slugFromMasterKey(key: string): string | null {
  return isMasterKey(key)
    ? key.slice(MASTER_KEY_PREFIX.length, -".jpg".length)
    : null;
}

/**
 * A rung never encodes more pixels than the master has. A 1200px master still
 * gets 400/750/1500/2000 written — each at its own intrinsic width — so every
 * key the srcSet advertises exists. Skipping the wide rungs instead would
 * leave a srcSet pointing at 404s, which is the failure the ladder gate in
 * derivatives.ts exists to prevent.
 */
export const DERIVATIVE_JPEG_QUALITY = 82;
export const DERIVATIVE_WEBP_QUALITY = 80;

/**
 * The staging master is a print-safe downscale, not the original: long edge at
 * most this, JPEG quality 80, sRGB, metadata stripped (#212). Bounded by the
 * edge, so a portrait and a landscape both fit.
 */
export const STAGING_MASTER_MAX_EDGE = 2500;
export const STAGING_MASTER_JPEG_QUALITY = 80;

/**
 * Safe to make immutable because the object key carries the master's content
 * hash: new bytes are a new key, so a URL's content never changes.
 */
export const WEB_DERIVATIVE_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

/**
 * The slug a dropped file declares, or null if the name cannot be one.
 *
 * A dropped master is named for the photo it is: `alley-cat.jpg` is the
 * catalog slug `alley-cat`. Extension is checked, base name is checked
 * against the one slug grammar, and nothing else is accepted — so a stray
 * `IMG_4021.HEIC` or a `.DS_Store` in the drop folder is reported by name
 * rather than silently uploaded as a photo nobody can link to.
 */
export function slugFromDroppedName(name: string): string | null {
  if (!name.toLowerCase().endsWith(".jpg")) return null;
  const base = name.slice(0, -".jpg".length);
  return PHOTO_SLUG_PATTERN.test(base) ? base : null;
}

/**
 * The key the original bytes of a dropped master are stored under, built from
 * the slug alone. Distinct from the catalog-backed resolver of the same shape
 * in master-key.ts (`masterKeyForSlug`), which returns null for unknown slugs.
 */
export function masterKeyFromSlug(slug: string): string {
  return `${MASTER_KEY_PREFIX}${slug}.jpg`;
}

/**
 * The key a photo's print asset is stored under, built from the slug alone
 * (#307). Distinct from `masterKeyFromSlug`, which points at the digital master
 * Prodigi must never receive.
 */
export function printAssetKeyFromSlug(slug: string): string {
  return `${PRINT_ASSET_KEY_PREFIX}${slug}.jpg`;
}

export type UploadTarget = {
  /** Production masters (promote only) or the staging masters downscale. */
  mastersBucket: string;
  webBucket: string;
};

/**
 * Refuses an upload that could send bytes to a bucket we do not own, before
 * any bytes move: the web bucket must be the public one, and the masters
 * bucket must be one of the two we maintain.
 *
 * There is no upload-gate refusal here. Guarding a live-served rung mattered
 * when a key was `{slug}/{rung}.jpg` and a half-written ladder was a 404; keys
 * are content-addressed now (`{slug}/{hash8}/…`), so an upload cannot change
 * what a live page shows — a changed image is a new URL.
 */
export function assertUploadIsSafe(target: UploadTarget): void {
  if (target.webBucket !== WEB_BUCKET_NAME) {
    throw new Error(
      `refusing to upload: web bucket must be ${WEB_BUCKET_NAME}, got ${target.webBucket}`,
    );
  }
  if (
    target.mastersBucket !== MASTERS_BUCKET_NAME &&
    target.mastersBucket !== STAGING_MASTERS_BUCKET_NAME
  ) {
    throw new Error(
      `refusing to upload: masters bucket must be ${MASTERS_BUCKET_NAME} or ` +
        `${STAGING_MASTERS_BUCKET_NAME}, got ${target.mastersBucket}`,
    );
  }
}

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
 * The URL side of the ladder (src/lib/derivatives.ts) needs the environment
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
 * The rung list, in one place. Adding a rung is a one-line change here and
 * nothing else: the srcSet, the ingest plan and the tests all read it.
 * Ascending, unique, positive — assertRungList() rejects anything else rather
 * than generating a ladder the srcSet cannot express.
 */
export const WEB_DERIVATIVE_WIDTHS = [400, 750, 1500, 2000] as const;
export type WebDerivativeWidth = (typeof WEB_DERIVATIVE_WIDTHS)[number];

/** Default display source — the middle rung of the ladder. */
export const WEB_DEFAULT_WIDTH: WebDerivativeWidth = 1500;

/** Output formats every rung is written in. No AVIF. */
export const WEB_DERIVATIVE_FORMATS = ["jpg", "webp"] as const;
export type WebDerivativeFormat = (typeof WEB_DERIVATIVE_FORMATS)[number];

/**
 * A master narrower than this is refused: the top rung is 2000, so anything
 * under it could never fill the largest public image. Derived from the rung
 * list, not spelled again, so the two cannot drift.
 */
export const MASTER_MIN_WIDTH: number =
  WEB_DERIVATIVE_WIDTHS[WEB_DERIVATIVE_WIDTHS.length - 1]!;

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

/** The first 8 hex chars of the master's SHA-256, which names its derivatives. */
export async function imageHash(bytes: Uint8Array): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 8);
}

/** A master below MASTER_MIN_WIDTH cannot fill the ladder; refuse it early. */
export function assertMasterIsUsable(width: number): void {
  if (!Number.isInteger(width) || width < MASTER_MIN_WIDTH) {
    throw new Error(
      `master is ${width}px wide; the floor is ${MASTER_MIN_WIDTH}px (the top rung)`,
    );
  }
}

/** True only for a well-formed `prints/{slug}.jpg` master key. */
export function isMasterKey(key: string): boolean {
  return MASTER_KEY_PATTERN.test(key);
}

/** The slug inside a well-formed `prints/{slug}.jpg` key, or null. */
export function slugFromMasterKey(key: string): string | null {
  return isMasterKey(key)
    ? key.slice(MASTER_KEY_PREFIX.length, -".jpg".length)
    : null;
}

/** Strictly ascending positive integers, or the ladder is not expressible. */
export function assertRungList(widths: readonly number[]): void {
  if (widths.length === 0) throw new Error("derivative rung list is empty");
  for (let i = 0; i < widths.length; i += 1) {
    const w = widths[i]!;
    if (!Number.isInteger(w) || w <= 0) {
      throw new Error(`derivative rung ${i} is not a positive integer: ${w}`);
    }
    if (i > 0 && w <= widths[i - 1]!) {
      throw new Error(
        `derivative rungs must strictly ascend: ${widths.join(", ")}`,
      );
    }
  }
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
 * The gallery/checkout fallback image: a small JPEG of the photo, long edge at
 * most this, metadata stripped, written by `publish-photos --apply` into
 * `public/placeholders/{slug}.jpg` (#257). It is the one image the site serves
 * with no R2 at all, so it ships in the repo rather than a bucket.
 */
export const PLACEHOLDER_MAX_EDGE = 1600;
export const PLACEHOLDER_JPEG_QUALITY = 80;

export type MasterUpload = {
  slug: string;
  /** Where the original bytes are written: `prints/{slug}.jpg` in MASTERS. */
  key: string;
};

export type DerivativeJob = {
  slug: string;
  /** The dropped file this object comes from, by name — `alley-cat.jpg`. */
  sourceName: string;
  /** The master's content hash, the path segment that makes the URL immutable. */
  hash: string;
  /** The rung this object is stored as, in the width the srcSet advertises. */
  rung: number;
  /** Pixels to resize to — the rung, capped at the master's own width. */
  pixels: number;
  /** jpg or webp. */
  format: WebDerivativeFormat;
  /** Where it is written: `{slug}/{hash8}/{rung}.{ext}` in WEB. */
  key: string;
};

export type IngestPlan = {
  /** One per accepted dropped file, written to the private masters bucket. */
  masters: MasterUpload[];
  jobs: DerivativeJob[];
  /** Dropped file names that are not `{slug}.jpg`. */
  ignoredNames: string[];
  /** Per-slug notes a dry run should show, e.g. clamped rungs. */
  notes: string[];
};

export type DroppedMaster = { name: string; width: number; hash: string };

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
 * One master upload plus one job per rung per dropped file, decided without
 * reading or writing anything — which is why the rules are testable at all.
 * `width` is the only thing that decides whether a rung is clamped.
 */
export function planDerivatives(
  drops: DroppedMaster[],
  rungs: readonly number[],
): IngestPlan {
  assertRungList(rungs);

  const masters: MasterUpload[] = [];
  const jobs: DerivativeJob[] = [];
  const ignoredNames: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const drop of drops) {
    const slug = slugFromDroppedName(drop.name);
    if (slug === null) {
      ignoredNames.push(drop.name);
      continue;
    }
    if (seen.has(slug)) {
      throw new Error(`two dropped masters declare the slug ${slug}`);
    }
    seen.add(slug);
    if (!Number.isInteger(drop.width) || drop.width <= 0) {
      throw new Error(
        `master ${drop.name} has no usable width: ${drop.width}`,
      );
    }

    masters.push({ slug, key: masterKeyFromSlug(slug) });

    let clamped = 0;
    for (const rung of rungs) {
      const pixels = Math.min(rung, drop.width);
      if (pixels < rung) clamped += 1;
      for (const format of WEB_DERIVATIVE_FORMATS) {
        jobs.push({
          slug,
          sourceName: drop.name,
          hash: drop.hash,
          rung,
          pixels,
          format,
          key: webDerivativeKey(slug, drop.hash, rung, format),
        });
      }
    }
    if (clamped > 0) {
      notes.push(
        `${slug}: master is ${drop.width}px wide, ${clamped} rung(s) stored at their own width`,
      );
    }
  }

  return { masters, jobs, ignoredNames, notes };
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
 * There is no `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` refusal here. Guarding a
 * live-served rung mattered when a key was `{slug}/{rung}.jpg` and a
 * half-written ladder was a 404; keys are content-addressed now
 * (`{slug}/{hash8}/…`), so an upload cannot change what a live page shows — a
 * changed image is a new URL.
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

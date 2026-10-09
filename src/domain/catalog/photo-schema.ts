import { HEX_64_PATTERN } from "../pricing/crypto-hex";
import { PHOTO_SLUG_PATTERN } from "./derivative-ladder";
import {
  type MasterFacts,
  type MasterFactsReason,
  parseMasterFacts,
} from "./master-facts";

/**
 * The one definition of a photo file, checked at build time by
 * `scripts/build-catalog.mjs` before anything is generated. The site never
 * parses YAML at runtime — Workers have no filesystem — so this module is the
 * contract the codegen enforces and the generated catalog is the runtime
 * shape. It imports only the slug grammar and the hex pattern, not `photos.ts`,
 * so the codegen can validate a catalog before `photos.ts` can be imported.
 *
 * The field names are the file's snake_case keys; the codegen normalises them
 * to camelCase for the generated TypeScript.
 */

/** The fixed gallery categories, in display order. */
export const PHOTO_CATEGORIES = ["fine-art", "archive", "film"] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

/** Runtime list, so the union and the validator cannot fall out of step. */
export const FILM_LOOKS = ["contrast", "sepia", "grayscale"] as const;
export type FilmLook = (typeof FILM_LOOKS)[number];

/** A photo file that passed every rule, with defaults applied. */
export type PhotoFile = {
  slug: string;
  title: string;
  caption: string;
  description: string;
  alt: string;
  category: PhotoCategory;
  filmLook?: FilmLook;
  order?: number;
  featured?: boolean;
  heroCaption?: string;
  published: boolean;
  masterSha256?: string;
  imageHash?: string;
  /** Oriented pixel size and orientation, measured from the master file (#295/#297). */
  master: MasterFacts;
};

export type PhotoValidation =
  | { ok: true; photo: PhotoFile }
  | { ok: false; problems: string[] };

/** 8-char lowercase hex, the shape of a `image_hash`. */
const HEX_8_PATTERN = /^[0-9a-f]{8}$/;

const KNOWN_KEYS = new Set([
  "slug",
  "title",
  "caption",
  "description",
  "alt",
  "category",
  "film_look",
  "order",
  "featured",
  "hero_caption",
  "published",
  "master_sha256",
  "image_hash",
  "master_width",
  "master_height",
  "orientation",
]);

const ALT_MAX = 200;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  name: string,
  value: unknown,
  problems: string[],
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${name}: required non-empty string`);
    return null;
  }
  return value;
}

function readSlug(
  filename: string,
  value: unknown,
  problems: string[],
): string {
  if (value !== undefined && typeof value !== "string") {
    problems.push("slug: must be a string");
    return filename;
  }
  const slug = value === undefined ? filename : value;
  if (!PHOTO_SLUG_PATTERN.test(slug)) {
    problems.push(`slug: ${slug} is not a valid slug`);
  } else if (slug !== filename) {
    problems.push(`slug: ${slug} must equal the filename ${filename}`);
  }
  return slug;
}

function readAlt(value: unknown, problems: string[]): string | null {
  const alt = requiredString("alt", value, problems);
  if (alt !== null && alt.length > ALT_MAX) {
    problems.push(`alt: must be ${ALT_MAX} characters or fewer`);
    return null;
  }
  return alt;
}

function readCategory(
  value: unknown,
  problems: string[],
): PhotoCategory | null {
  if (
    typeof value !== "string" ||
    !PHOTO_CATEGORIES.includes(value as PhotoCategory)
  ) {
    problems.push("category: must be one of fine-art, archive, film");
    return null;
  }
  return value as PhotoCategory;
}

function readFilmLook(
  value: unknown,
  category: PhotoCategory | null,
  problems: string[],
): FilmLook | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !FILM_LOOKS.includes(value as FilmLook)
  ) {
    problems.push("film_look: must be one of contrast, sepia, grayscale");
    return undefined;
  }
  if (category !== "film") {
    problems.push("film_look: only allowed when category is film");
    return undefined;
  }
  return value as FilmLook;
}

function readOrder(value: unknown, problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    problems.push("order: must be an integer");
    return undefined;
  }
  return value;
}

function readBoolean(
  name: string,
  value: unknown,
  problems: string[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    problems.push(`${name}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readHeroCaption(
  value: unknown,
  featured: boolean | undefined,
  problems: string[],
): string | undefined {
  if (featured === true) {
    return requiredString("hero_caption", value, problems) ?? undefined;
  }
  if (value !== undefined) {
    problems.push("hero_caption: only allowed when featured is true");
  }
  return undefined;
}

function readPublished(value: unknown, problems: string[]): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    problems.push("published: must be a boolean");
    return true;
  }
  return value;
}

function readHex(
  name: string,
  value: unknown,
  length: number,
  pattern: RegExp,
  problems: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    value !== value.toLowerCase()
  ) {
    problems.push(`${name}: must be ${length}-character lowercase hex`);
    return undefined;
  }
  return value;
}

const MASTER_FACTS_MESSAGE: Record<MasterFactsReason, string> = {
  "not-positive-integer":
    "master_width and master_height must be positive integers",
  "unknown-orientation":
    "orientation must be one of landscape, portrait, square",
  "orientation-mismatch":
    "orientation does not match master_width and master_height",
};

/**
 * The master facts, if the file carries any of the three keys. A set that is
 * present must be complete and consistent: a half-written trio is a publish
 * bug, not a missing value, so it fails rather than being ignored. `undefined`
 * means the file has none of the three keys — allowed for drafts (unpublished)
 * but rejected for a published photo once #297 has backfilled the catalog.
 */
function readMasterFacts(
  data: Record<string, unknown>,
  problems: string[],
): MasterFacts | undefined {
  const present =
    data.master_width !== undefined ||
    data.master_height !== undefined ||
    data.orientation !== undefined;
  if (!present) return undefined;

  const result = parseMasterFacts({
    width: data.master_width,
    height: data.master_height,
    orientation: data.orientation,
  });
  if (!result.ok) {
    problems.push(MASTER_FACTS_MESSAGE[result.reason]);
    return undefined;
  }
  return result.facts;
}

/**
 * Validates one photo file against every rule, collecting all problems rather
 * than stopping at the first, so a single run reports the whole file. The
 * filename is the slug the file declares — a `slug:` that disagrees with it is
 * an error, not a rename.
 *
 * `requirePublishedHashes` (default true) enforces that a published photo
 * carries `master_sha256` and `image_hash`, the two values the persisted catalog
 * must have (#245). `publish-photos` passes false: it validates the owner's
 * drop-folder YAML *before* it writes those two keys, so requiring them there
 * would reject every new photo.
 *
 * `requireMasterFacts` (default true) enforces that a published photo carries
 * `master_width`, `master_height` and `orientation` (#297). The backfill script
 * passes false so it can read and patch YAMLs that are mid-backfill; every other
 * caller — build-catalog, audit, the runtime — requires them once #297 is done.
 */
export function validatePhotoFile(
  filename: string,
  data: unknown,
  {
    requirePublishedHashes = true,
    requireMasterFacts = true,
  }: { requirePublishedHashes?: boolean; requireMasterFacts?: boolean } = {},
): PhotoValidation {
  if (!isMapping(data)) {
    return { ok: false, problems: ["file: expected a YAML mapping"] };
  }

  const problems: string[] = [];
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${key}: unknown key`);
  }

  const slug = readSlug(filename, data.slug, problems);
  const title = requiredString("title", data.title, problems);
  const caption = requiredString("caption", data.caption, problems);
  const description = requiredString("description", data.description, problems);
  const alt = readAlt(data.alt, problems);
  const category = readCategory(data.category, problems);
  const filmLook = readFilmLook(data.film_look, category, problems);
  const order = readOrder(data.order, problems);
  const featured = readBoolean("featured", data.featured, problems);
  const heroCaption = readHeroCaption(data.hero_caption, featured, problems);
  const published = readPublished(data.published, problems);
  const masterSha256 = readHex(
    "master_sha256",
    data.master_sha256,
    64,
    HEX_64_PATTERN,
    problems,
  );
  const imageHash = readHex(
    "image_hash",
    data.image_hash,
    8,
    HEX_8_PATTERN,
    problems,
  );
  const master = readMasterFacts(data, problems);

  // A published photo is served from the real ladder, so the two values the
  // publish script writes are required, not optional: without them the gallery
  // and the release check have no master to point at (#245). An absent field is
  // named here; a malformed one was already reported by readHex above.
  if (published && requirePublishedHashes) {
    if (data.master_sha256 === undefined) {
      problems.push("master_sha256: required for a published photo");
    }
    if (data.image_hash === undefined) {
      problems.push("image_hash: required for a published photo");
    }
  }

  // Master pixel facts are required for a published photo once #297 backfills
  // the catalog: without them the release check has no size to compare and the
  // page cannot size the gallery preview (#295). Drafts (unpublished) may lack
  // them until they go through publish-photos + --sync.
  if (published && requireMasterFacts && !master) {
    problems.push(
      "master_width, master_height and orientation: required for a published photo",
    );
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  // Every required field is non-null here because problems would be non-empty
  // otherwise; the assertions state that invariant to the compiler.
  return {
    ok: true,
    photo: {
      slug,
      title: title!,
      caption: caption!,
      description: description!,
      alt: alt!,
      category: category!,
      filmLook,
      order,
      featured,
      heroCaption,
      published,
      masterSha256,
      imageHash,
      master: master!,
    },
  };
}

import { HEX_32_PATTERN, HEX_64_PATTERN } from "../pricing/crypto-hex";
import { isRecord } from "../json/record";
import { PHOTO_SLUG_PATTERN } from "./derivative-ladder";
import {
  isLocale,
  TRANSLATED_LOCALES,
  type Locale,
} from "../i18n/locale";
import {
  type MasterFacts,
  type MasterFactsReason,
  parseMasterFacts,
} from "./master-facts";
import {
  type OfferProblem,
  parsePrintOffer,
  type PrintOffer,
} from "./print-offer";
import {
  BELOW_MIN_PPI_REASON,
  SHAPE_MISMATCH_REASON,
} from "./print-eligibility";

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

/**
 * One locale's copy of a photo's words.
 *
 * The same fields the source carries — title, caption, description, alt — plus
 * the hero caption, which belongs to the featured photo alone and so is
 * required there and forbidden everywhere else, exactly as the source's own
 * `hero_caption` is.
 *
 * The fields are the same in every locale on purpose: a locale that could omit
 * a field would have a fallback, and a fallback is a page in the wrong
 * language. A locale that cannot be written is a locale that is not published.
 */
export type PhotoTranslation = {
  title: string;
  caption: string;
  description: string;
  alt: string;
  heroCaption?: string | undefined;
};

/** A photo file that passed every rule, with defaults applied. */
export type PhotoFile = {
  slug: string;
  title: string;
  caption: string;
  description: string;
  alt: string;
  category: PhotoCategory;
  filmLook?: FilmLook | undefined;
  order?: number | undefined;
  featured?: boolean | undefined;
  heroCaption?: string | undefined;
  published: boolean;
  /**
   * The photo's copy in every other locale it is published in.
   *
   * The top-level fields above are the source — the default locale's copy — and
   * these are the translations of them. A published photo must carry one for
   * every `TRANSLATED_LOCALES` locale, and the build fails when one is missing
   * or partial, so a photo is never published in one language and English in
   * another.
   */
  translations: Partial<Record<Locale, PhotoTranslation>>;
  masterSha256?: string | undefined;
  imageHash?: string | undefined;
  /** Oriented pixel size and orientation, measured from the master file (#295/#297). */
  master?: MasterFacts | undefined;
  /**
   * The pre-rotated file Prodigi receives (#307): its SHA-256 and the MD5 sent
   * as `assets[0].md5Hash`. Generated together by `publish-photos`; a file
   * carries both keys or neither.
   */
  printAsset?: { sha256: string; md5: string } | undefined;
  /**
   * A placeholder-phase entry (see `NEXT_PUBLIC_PLACEHOLDER_PHOTOS`): it is
   * listed in the gallery so the shop is not empty, but it has no objects in
   * `nessebar-lens-masters` and is not for sale. The release gate
   * (`verify-masters`) and the bucket audit skip it; every real photo is still
   * checked. Remove the marker when the real master is promoted.
   */
  placeholder?: boolean | undefined;
  /**
   * The print offer (#300): which sizes are sold per physical format. Derived
   * from the master by `publish-photos` and validated here against the same
   * facts. Required on a published photo; the owner narrows it by deleting
   * entries in the publish PR, which `publish-photos` then preserves.
   */
  printOffer?: PrintOffer | undefined;
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
  "placeholder",
  "translations",
  "master_sha256",
  "image_hash",
  "master_width",
  "master_height",
  "orientation",
  "print_asset_sha256",
  "print_asset_md5",
  "print_options",
]);

const ALT_MAX = 200;

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

function readAlt(
  name: string,
  value: unknown,
  problems: string[],
): string | null {
  const alt = requiredString(name, value, problems);
  if (alt !== null && alt.length > ALT_MAX) {
    problems.push(`${name}: must be ${ALT_MAX} characters or fewer`);
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
  name: string,
  value: unknown,
  featured: boolean | undefined,
  problems: string[],
): string | undefined {
  if (featured === true) {
    return requiredString(name, value, problems) ?? undefined;
  }
  if (value !== undefined) {
    problems.push(`${name}: only allowed when featured is true`);
  }
  return undefined;
}

/**
 * The fields one locale's copy may carry.
 *
 * The same set as the source's own words, so a translation cannot quietly
 * carry a field the source does not have — and cannot miss one either, which
 * the completeness check below is what catches.
 */
const TRANSLATION_KEYS = new Set([
  "title",
  "caption",
  "description",
  "alt",
  "hero_caption",
]);

/**
 * One locale's copy, read with the same rules as the source's.
 *
 * The field names carry the locale, so a problem in the Bulgarian copy reads
 * `translations.bg.alt: required non-empty string` rather than `alt`, which
 * would point at the English field and send the reader to the wrong file.
 */
function readTranslation(
  locale: Locale,
  value: unknown,
  featured: boolean | undefined,
  problems: string[],
): PhotoTranslation | null {
  if (!isRecord(value)) {
    problems.push(`translations.${locale}: expected a mapping of copy`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!TRANSLATION_KEYS.has(key)) {
      problems.push(`translations.${locale}.${key}: unknown key`);
    }
  }
  const title = requiredString(
    `translations.${locale}.title`,
    value.title,
    problems,
  );
  const caption = requiredString(
    `translations.${locale}.caption`,
    value.caption,
    problems,
  );
  const description = requiredString(
    `translations.${locale}.description`,
    value.description,
    problems,
  );
  const alt = readAlt(`translations.${locale}.alt`, value.alt, problems);
  const heroCaption = readHeroCaption(
    `translations.${locale}.hero_caption`,
    value.hero_caption,
    featured,
    problems,
  );
  if (title === null || caption === null || description === null || alt === null) {
    return null;
  }
  return { title, caption, description, alt, heroCaption };
}

/**
 * Every locale's copy, or none.
 *
 * An absent `translations` is allowed — a draft has no translations yet, and
 * the rule for drafts is explicit below rather than implied. A present one is
 * checked: a locale the site does not know is an error rather than a silently
 * ignored block, because an ignored block is a translation nobody will ever
 * read.
 */
function readTranslations(
  value: unknown,
  featured: boolean | undefined,
  problems: string[],
): {
  translations: Partial<Record<Locale, PhotoTranslation>>;
  /** The locales the file carried, whether or not their copy was valid. */
  seen: Set<Locale>;
} {
  const translations: Partial<Record<Locale, PhotoTranslation>> = {};
  const seen = new Set<Locale>();
  if (value === undefined) return { translations, seen };
  if (!isRecord(value)) {
    problems.push("translations: expected a mapping of locale to copy");
    return { translations, seen };
  }
  for (const [locale, translation] of Object.entries(value)) {
    if (!isLocale(locale)) {
      problems.push(`translations.${locale}: unknown locale`);
      continue;
    }
    seen.add(locale);
    const read = readTranslation(locale, translation, featured, problems);
    if (read) translations[locale] = read;
  }
  return { translations, seen };
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
 *
 * For a published photo the facts are enforced by `requireMasterFacts` (default
 * true): validation produces a problem when they are absent, so the returned
 * `photo.master` is `MasterFacts` at the type level while the raw value can be
 * `undefined` for drafts validated with `requireMasterFacts: false`.
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
 * The print asset's sha256 and md5 (#307). The two keys travel together: a file
 * with only one is a publish bug (the asset would be uploaded without the MD5
 * Prodigi checks, or vice versa), so it fails rather than being ignored.
 * `undefined` means the file carries neither key — allowed for drafts, but a
 * published photo requires one once the catalog is backfilled (#307 PR 2).
 */
function readPrintAsset(
  data: Record<string, unknown>,
  problems: string[],
): { sha256: string; md5: string } | undefined {
  const hasSha = data.print_asset_sha256 !== undefined;
  const hasMd5 = data.print_asset_md5 !== undefined;
  if (!hasSha && !hasMd5) return undefined;
  if (hasSha !== hasMd5) {
    problems.push(
      "print_asset_sha256 and print_asset_md5: required together",
    );
    return undefined;
  }

  const sha256 = readHex(
    "print_asset_sha256",
    data.print_asset_sha256,
    64,
    HEX_64_PATTERN,
    problems,
  );
  const md5 = readHex(
    "print_asset_md5",
    data.print_asset_md5,
    32,
    HEX_32_PATTERN,
    problems,
  );
  if (sha256 === undefined || md5 === undefined) return undefined;
  return { sha256, md5 };
}

/**
 * One `parsePrintOffer` problem as a `field: message` line, so a bad offer
 * reads the same way as every other schema problem. The field is the exact
 * `print_options` path the problem is about; the message explains it.
 */
function offerProblemMessage(problem: OfferProblem): string {
  const path = problem.size
    ? `print_options.${problem.format}.${problem.size}`
    : `print_options.${problem.format}`;
  switch (problem.reason) {
    case "not-a-map":
      return "print_options: must be a map of format to a list of sizes";
    case "missing-format":
      return `${path}: required`;
    case "unknown-format":
      return `${path}: unknown format`;
    case "not-a-list":
      return `${path}: must be a list of sizes`;
    case "unknown-size":
      return `${path}: unknown size`;
    case "not-offered-for-format":
      return `${path}: not offered for ${problem.format}`;
    case "duplicate-size":
      return `${path}: listed more than once`;
    case BELOW_MIN_PPI_REASON:
      return `${path}: below the ${problem.effectivePpi} PPI minimum`;
    case SHAPE_MISMATCH_REASON:
      return `${path}: does not match the master's shape`;
  }
}

/**
 * The print offer (#300), validated against the master. A file with no
 * `print_options` returns `undefined` — allowed for a draft, required for a
 * published photo once the rollout lands. The offer is only checked when the
 * master facts are present, because every rule is relative to them; a published
 * photo without facts is already reported by the master-facts check.
 */
function readPrintOffer(
  data: Record<string, unknown>,
  master: MasterFacts | undefined,
  problems: string[],
): PrintOffer | undefined {
  if (data.print_options === undefined) return undefined;
  if (master === undefined) return undefined;

  const result = parsePrintOffer(data.print_options, master);
  if (!result.ok) {
    for (const problem of result.problems) {
      problems.push(offerProblemMessage(problem));
    }
    return undefined;
  }
  return result.offer;
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
 *
 * `requirePrintAssets` (default true) enforces that a published photo carries
 * `print_asset_sha256` and `print_asset_md5` (#307). `publish-photos` passes
 * false: it validates the owner's drop-folder YAML *before* it renders the asset
 * and writes those two keys, so requiring them there would reject every new
 * photo.
 *
 * `requirePrintOffer` (default true) enforces that a published photo carries a
 * valid `print_options` (#300). `publish-photos` passes false for the drop
 * folder: a new photo's offer is derived and written by the publish run, so
 * requiring it in the input would reject every new photo.
 */
export function validatePhotoFile(
  filename: string,
  data: unknown,
  {
    requirePublishedHashes = true,
    requireMasterFacts = true,
    requirePrintAssets = true,
    requirePrintOffer = true,
    requireTranslations = true,
  }: {
    requirePublishedHashes?: boolean;
    requireMasterFacts?: boolean;
    requirePrintAssets?: boolean;
    requirePrintOffer?: boolean;
    /**
     * Whether a published photo must carry a translation for every locale it
     * is published in.
     *
     * True for the catalog build, which is where the rule bites: a published
     * photo with no Bulgarian copy is a photo half the site is missing. False
     * for `publish-photos`, which validates the owner's file *before* it writes
     * the generated keys — the same reason it passes the other four flags as
     * false. The script preserves the translations it is given; it does not
     * write them.
     */
    requireTranslations?: boolean;
  } = {},
): PhotoValidation {
  if (!isRecord(data)) {
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
  const alt = readAlt("alt", data.alt, problems);
  const category = readCategory(data.category, problems);
  const filmLook = readFilmLook(data.film_look, category, problems);
  const order = readOrder(data.order, problems);
  const featured = readBoolean("featured", data.featured, problems);
  const heroCaption = readHeroCaption(
    "hero_caption",
    data.hero_caption,
    featured,
    problems,
  );
  const published = readPublished(data.published, problems);
  const placeholder = readBoolean("placeholder", data.placeholder, problems);
  const { translations, seen: translatedLocales } = readTranslations(
    data.translations,
    featured,
    problems,
  );
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
  const printAsset = readPrintAsset(data, problems);
  const printOffer = readPrintOffer(data, master, problems);

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

  // A published photo requires a print asset now that the catalog is
  // backfilled: without it checkout would send Prodigi the unrotated master
  // (#307). `print_asset_sha256` and `print_asset_md5` are rendered and written
  // together by `publish-photos`, so a half-present pair was already rejected by
  // readPrintAsset above.
  if (published && requirePrintAssets && !printAsset) {
    problems.push(
      "print_asset_sha256 and print_asset_md5: required for a published photo",
    );
  }

  // A published photo requires a print offer now that #300 writes it: checkout
  // (#301) and the configurator (#302) read only this value, so a missing offer
  // would silently sell nothing rather than fail.
  if (published && requirePrintOffer && !printOffer) {
    problems.push("print_options: required for a published photo");
  }

  // A published photo carries its own copy in every locale it is published in.
  //
  // The rule is on the photo, not on the file: an unpublished draft may have no
  // translations yet, and the moment it is published it must have all of them.
  // Publishing a photo in one language and English in another is the failure
  // this exists to prevent — a Bulgarian page that says "Solitude at Sunrise"
  // is a page that lies about its own language.
  //
  // A partial translation is the same failure: the fields are checked above, so
  // a translation that reached this point is complete, and one that did not is
  // already reported. What is reported here is the locale that is missing
  // altogether.
  if (published && requireTranslations) {
    for (const locale of TRANSLATED_LOCALES) {
      // A locale the file carried is not "missing" even when its copy was
      // rejected: the field that is wrong is already named, and naming it twice
      // — once for the field and once for the locale — would send the reader
      // looking for a missing block that is right there.
      if (!translatedLocales.has(locale)) {
        problems.push(
          `translations.${locale}: required for a published photo`,
        );
      }
    }
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
      placeholder,
      translations,
      masterSha256,
      imageHash,
      master,
      printAsset,
      printOffer,
    },
  };
}

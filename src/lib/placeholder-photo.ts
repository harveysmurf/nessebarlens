/**
 * What the gallery shows for one photo. One place decides this, so the answer
 * to "which image is live" is a single function rather than a habit spread
 * across components.
 *
 * Two sources, in priority order:
 *   1. the R2 derivative ladder, when it is explicitly enabled
 *   2. the committed placeholder JPEG in /public/placeholders
 *
 * The ladder is off by default and is not switched on by the base URL being
 * configured — see lib/derivatives.ts. Both buckets were empty while the base
 * was already set in every environment, so "base is set" cannot mean "files
 * exist". With the flag off this module is byte-identical to the pre-ladder
 * behaviour, which is why the switch could be added before the upload.
 *
 * Aspect ratio is CSS, not filenames. Derivatives are resized by width with
 * height following the photo's own ratio, so portrait and landscape both fit
 * the same rung; a tile that must look uniform sets `aspect-ratio` and
 * `object-fit: cover`, and the photo page drops both to show it uncropped.
 *
 * `preferred` picks which rung is the `src` — the image a browser loads before
 * it has parsed the srcSet, and the one a client that ignores srcSet gets
 * forever. It does NOT narrow the srcSet: the ladder stays complete so the
 * browser can still pick a different rung for a different viewport. A call site
 * asking for 2500 is saying "this is the largest thing on the page", which is
 * different from "only ever offer 2500".
 */

import {
  WEB_DEFAULT_WIDTH,
  webDerivativeUrls,
  type WebDerivativeWidth,
} from "./derivatives";
import { PHOTO_SLUG_PATTERN } from "./master-key";

/**
 * Bump when the placeholder JPEGs change so browsers skip stale CDN copies.
 * Kept in one place because the same bump copied into a second file is
 * exactly the drift this repo keeps catching.
 */
export const PLACEHOLDER_VERSION = 3;

export type GalleryImage = {
  src: string;
  /**
   * Null when there is no ladder. Never a one-rung srcSet: it would render
   * correctly and imply a responsive ladder that does not exist, which is
   * how a missing ladder stays invisible.
   */
  srcSet: string | null;
  /** "ladder" or "placeholder" — surfaced for tests and debugging. */
  source: "ladder" | "placeholder";
};

/**
 * The committed placeholder JPEG for a slug, or null when the slug is not a
 * safe path segment. A slug that would escape /public/placeholders must not
 * produce a request at all, so the caller can render alt text instead.
 */
export function placeholderPhotoSrc(slug: string): string | null {
  // The catalog's own slug grammar, not a second copy of it: a slug the
  // catalog accepts must resolve, and one it rejects must not.
  if (!PHOTO_SLUG_PATTERN.test(slug)) return null;
  return `/placeholders/${slug}.jpg?v=${PLACEHOLDER_VERSION}`;
}

/**
 * The image for one slug. Null only when the slug is unusable — the ladder
 * being off is a normal state, not a failure, and degrades to the
 * placeholder rather than to nothing.
 */
export function galleryImage(
  slug: string,
  preferred: WebDerivativeWidth = WEB_DEFAULT_WIDTH,
): GalleryImage | null {
  if (!PHOTO_SLUG_PATTERN.test(slug)) return null;

  const ladder = webDerivativeUrls(slug);
  if (ladder) {
    // Only take a rung the ladder actually has. A caller asking for a width
    // that is not in WEB_DERIVATIVE_WIDTHS falls back to the default rather
    // than building a URL for an object ingest never writes.
    const rung = ladder.urls[preferred] ? preferred : WEB_DEFAULT_WIDTH;
    return { src: ladder.urls[rung], srcSet: ladder.srcSet, source: "ladder" };
  }

  // The slug is already known good here, so this cannot be null.
  return {
    src: placeholderPhotoSrc(slug)!,
    srcSet: null,
    source: "placeholder",
  };
}

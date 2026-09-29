/**
 * The placeholder-phase image source.
 *
 * This is the single place that decides what the gallery serves while the
 * real derivative ladder (lib/derivatives.ts) is not wired up. It exists as
 * its own module rather than as a template literal inside the component so
 * that the placeholder phase is *tested* and not just asserted in a comment:
 * the whole point of this file is that the thing which changes when real
 * JPEGs ship is one function with one test, not a prop threaded through a
 * component.
 *
 * When real derivatives land, this becomes:
 *   const d = webDerivativeUrls(slug);
 *   return d ? { src: d.src, srcSet: d.srcSet } : { src: legacyPlaceholder(slug) };
 * and the test moves with it. Nothing else about the page changes.
 */

/**
 * Bump when the placeholder JPEGs change so browsers skip stale CDN copies.
 * Kept in one place because the same bump across a component and a copy in
 * another file is exactly the drift this repo keeps catching.
 */
import { PHOTO_SLUG_PATTERN } from "./master-key";

export const PLACEHOLDER_VERSION = 3;

export type PlaceholderImage = {
  /** Always a single URL: there is no ladder to choose a rung from yet. */
  src: string;
  /** Null, never a fabricated one-rung srcSet -- a srcSet of one is a lie. */
  srcSet: null;
};

/**
 * Returns the committed placeholder JPEG for a slug, or null when the slug
 * is not a safe path segment. The caller renders alt text only in that case,
 * so a slug that would escape /public/placeholders produces a broken image
 * rather than a readable file from somewhere else on disk.
 */
export function placeholderPhotoSrc(slug: string): string | null {
  // The catalog's own slug grammar, not a second copy of it: a slug the
  // catalog accepts must resolve, and one it rejects must not.
  if (!PHOTO_SLUG_PATTERN.test(slug)) return null;
  return `/placeholders/${slug}.jpg?v=${PLACEHOLDER_VERSION}`;
}

/** As placeholderPhotoSrc, typed for a component that spreads `srcSet`. */
export function placeholderPhotoImage(slug: string): PlaceholderImage | null {
  const src = placeholderPhotoSrc(slug);
  return src === null ? null : { src, srcSet: null };
}

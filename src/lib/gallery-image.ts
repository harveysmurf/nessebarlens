/**
 * What the gallery shows for one photo, now that there is one image source:
 * the R2 derivative ladder (#245). A published photo always carries an
 * `image_hash`, and `NEXT_PUBLIC_WEB_IMAGES_BASE` points at the CDN, so the
 * ladder is the only path — there is no placeholder fallback.
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
 * asking for 2000 is saying "this is the largest thing on the page", which is
 * different from "only ever offer 2000".
 */

import {
  PHOTO_SLUG_PATTERN,
  WEB_DEFAULT_WIDTH,
  type WebDerivativeWidth,
} from "./derivative-ladder";
import { webDerivativeUrls, type WebPhotoSource } from "./derivatives";

export type GalleryImage = {
  src: string;
  /** The JPEG srcset. */
  srcSet: string;
  /** The WebP srcset for the `<source>`. */
  webpSrcSet: string;
};

/**
 * The image for one photo, or null when the slug is unusable or the ladder
 * cannot be built (the base is unset/not https, or the photo has no hash). A
 * null result is a caller's cue to render the alt text rather than a URL to a
 * file that does not exist.
 */
export function galleryImage(
  photo: WebPhotoSource,
  preferred: WebDerivativeWidth = WEB_DEFAULT_WIDTH,
): GalleryImage | null {
  if (!PHOTO_SLUG_PATTERN.test(photo.slug)) return null;

  const ladder = webDerivativeUrls(photo);
  if (!ladder) return null;

  // Only take a rung the ladder actually has. A caller asking for a width that
  // is not in WEB_DERIVATIVE_WIDTHS falls back to the default rather than
  // building a URL for an object ingest never writes.
  const rung = ladder.jpeg[preferred] ? preferred : WEB_DEFAULT_WIDTH;
  return {
    src: ladder.jpeg[rung],
    srcSet: ladder.srcSet,
    webpSrcSet: ladder.webpSrcSet,
  };
}

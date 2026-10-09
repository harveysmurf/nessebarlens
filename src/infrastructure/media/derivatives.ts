/**
 * Public gallery derivatives — four widths in two formats, pre-rendered at
 * ingest/publish into nessebar-lens-web as:
 *   {slug}/{hash8}/400.jpg | 750 | 1500 | 2000, and the same as .webp
 * Never link masters or Image Resizing URLs from the gallery.
 * No third-party image hosts (Unsplash etc.) — missing base → no remote image.
 *
 * Naming: masters are prints/{slug}.jpg; derivatives are
 * {slug}/{hash8}/{width}.{ext}. Name by intrinsic width, never by device — a
 * retina phone, a tablet and a desktop tile are all just "width N", and the
 * browser picks the rung from the srcSet/sizes attributes in the HTML. The
 * hash segment is the master's content hash: a changed image is a new URL, so
 * the objects can be served immutable.
 *
 * The base being configured is the whole condition for serving the ladder: a
 * published photo carries an image_hash and its derivatives exist, so the two
 * states are equivalent. A photo with no image_hash has nothing to serve.
 */

import {
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
  webDerivativeKey,
  type WebDerivativeFormat,
  type WebDerivativeWidth,
} from "../../domain/catalog/derivative-ladder";
import { webImagesBase } from "../config/config";

/** The catalog fields the web ladder needs — a slug and, once published, its hash. */
export type WebPhotoSource = { slug: string; imageHash?: string };

export type WebDerivativeUrls = {
  /** The JPEG URL for every rung, keyed by width. */
  jpeg: Record<WebDerivativeWidth, string>;
  /** The WebP URL for every rung, keyed by width. */
  webp: Record<WebDerivativeWidth, string>;
  /** Default display source — the middle-rung JPEG. */
  src: string;
  /** JPEG srcset, one entry per rung. */
  srcSet: string;
  /** WebP srcset, one entry per rung. */
  webpSrcSet: string;
};

/**
 * The URLs for one photo, or null when the ladder is off, the base is
 * unusable, or the photo has no image_hash yet (a placeholder). Null means
 * "fall back to the placeholder", never "render nothing".
 */
export function webDerivativeUrls(
  photo: WebPhotoSource,
): WebDerivativeUrls | null {
  const base = webImagesBase();
  if (!base) return null;
  // A catalog entry without a hash has not been published yet, so no
  // derivative exists at any key we could build.
  const hash = photo.imageHash;
  if (!hash) return null;

  const url = (width: WebDerivativeWidth, ext: WebDerivativeFormat) =>
    `${base}/${webDerivativeKey(photo.slug, hash, width, ext)}`;
  const urlsFor = (ext: WebDerivativeFormat) =>
    Object.fromEntries(
      WEB_DERIVATIVE_WIDTHS.map((w) => [w, url(w, ext)]),
    ) as Record<WebDerivativeWidth, string>;

  const jpeg = urlsFor("jpg");
  const webp = urlsFor("webp");
  const srcSetOf = (urls: Record<WebDerivativeWidth, string>) =>
    WEB_DERIVATIVE_WIDTHS.map((w) => `${urls[w]} ${w}w`).join(", ");

  return {
    jpeg,
    webp,
    src: jpeg[WEB_DEFAULT_WIDTH],
    srcSet: srcSetOf(jpeg),
    webpSrcSet: srcSetOf(webp),
  };
}

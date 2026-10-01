/**
 * Public gallery derivatives — Squarespace ladder trimmed to three widths.
 * Pre-rendered at ingest into nessebar-lens-web as:
 *   {slug}/750.jpg | {slug}/1500.jpg | {slug}/2500.jpg
 * Never link masters or Image Resizing URLs from the gallery.
 * No third-party image hosts (Unsplash etc.) — missing base → no remote image.
 *
 * Naming: masters are prints/{slug}.jpg, derivatives are {slug}/{width}.jpg.
 * Name by intrinsic width, never by device — a retina phone, a tablet and a
 * desktop tile are all just "width N", and the browser picks the rung from
 * the srcSet/sizes attributes in the HTML. Nested rather than flat so one
 * photo's rungs delete together under a single prefix.
 *
 * THE GATE. The ladder is served only when NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED
 * is set, and not merely because the base URL is set. Those are different
 * facts: the base was configured in all three environments while both buckets
 * were still empty, so treating "base is set" as "files exist" would have
 * replaced every working placeholder with a 404. Turning the flag on is the
 * deliberate act that says the upload happened.
 */

import {
  derivativeKey,
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
  type WebDerivativeWidth,
} from "./derivative-ladder";
import { webDerivativesEnabled, webImagesBase } from "./config";

/**
 * Public gallery derivative URLs for the site.
 *
 * The rung list, bucket names and key shapes are declared in
 * derivative-ladder.ts, which the ingest script loads directly. Nothing is
 * re-exported from here: a caller that wants a rung imports it from the module
 * that owns it, so "which file declares this" has one answer and adding a rung
 * does not mean editing a second list of names.
 */
export type WebDerivativeUrls = {
  /** One URL per entry in WEB_DERIVATIVE_WIDTHS, keyed by that width. */
  urls: Record<WebDerivativeWidth, string>;
  /** Default display source. */
  src: string;
  srcSet: string;
};

/**
 * Returns null unless the ladder is explicitly enabled and the base resolves.
 * Production must not fall back to any remote host, and must not serve the
 * ladder from an empty bucket.
 */
export function webDerivativeUrls(slug: string): WebDerivativeUrls | null {
  if (!webDerivativesEnabled()) return null;
  const base = webImagesBase();
  if (!base) return null;

  // derivativeKey owns the {slug}/{rung}.jpg shape; this module only adds
  // the base. Spelling the path again here is the one copy that could
  // disagree with the key the ingest writes.
  const path = (w: WebDerivativeWidth) => `${base}/${derivativeKey(slug, w)}`;
  const urls = Object.fromEntries(
    WEB_DERIVATIVE_WIDTHS.map((w) => [w, path(w)]),
  ) as Record<WebDerivativeWidth, string>;

  return {
    urls,
    src: urls[WEB_DEFAULT_WIDTH],
    srcSet: WEB_DERIVATIVE_WIDTHS.map((w) => `${urls[w]} ${w}w`).join(", "),
  };
}

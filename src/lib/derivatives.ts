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
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
  type WebDerivativeWidth,
} from "./derivative-ladder";
import { envFlag, envString, stripTrailingSlashes } from "./env";

// Rungs, bucket names and key shapes are declared in derivative-ladder.ts so
// the ingest script reads the same list this module serves. Re-exported here
// because the site only ever asks for them through this module.
export {
  MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
  type WebDerivativeWidth,
} from "./derivative-ladder";

export type WebDerivativeUrls = {
  /** One URL per entry in WEB_DERIVATIVE_WIDTHS, keyed by that width. */
  urls: Record<WebDerivativeWidth, string>;
  /** Default display source. */
  src: string;
  srcSet: string;
};

/**
 * Public base for nessebar-lens-web derivatives only (absolute https).
 * Real boundary: keep nessebar-lens-masters private (no r2.dev / public access).
 * Point this env at the web bucket public URL only — never the masters bucket.
 * A path regex cannot catch masters: public r2.dev URLs omit the bucket name.
 */
export function webImagesBase(): string | undefined {
  const raw = envString("NEXT_PUBLIC_WEB_IMAGES_BASE");
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  return stripTrailingSlashes(`${url.origin}${url.pathname}`);
}

/**
 * Returns null unless the ladder is explicitly enabled and the base resolves.
 * Production must not fall back to any remote host, and must not serve the
 * ladder from an empty bucket.
 */
export function webDerivativeUrls(slug: string): WebDerivativeUrls | null {
  if (!envFlag("NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED")) return null;
  const base = webImagesBase();
  if (!base) return null;

  const path = (w: WebDerivativeWidth) => `${base}/${slug}/${w}.jpg`;
  const urls = Object.fromEntries(
    WEB_DERIVATIVE_WIDTHS.map((w) => [w, path(w)]),
  ) as Record<WebDerivativeWidth, string>;

  return {
    urls,
    src: urls[WEB_DEFAULT_WIDTH],
    srcSet: WEB_DERIVATIVE_WIDTHS.map((w) => `${urls[w]} ${w}w`).join(", "),
  };
}

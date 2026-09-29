/**
 * Public gallery derivatives — Squarespace ladder trimmed to three widths.
 * Pre-rendered at ingest into nessebar-lens-web as:
 *   {slug}/750.jpg | {slug}/1500.jpg | {slug}/2500.jpg
 * Never link masters or Image Resizing URLs from the gallery.
 * No third-party image hosts (Unsplash etc.) — missing base → no remote image.
 *
 * NOT WIRED UP. Nothing in src/ imports this module yet: the gallery still
 * serves committed placeholders via lib/placeholder-photo.ts. That is the
 * placeholder phase, not an oversight, and this file is the prepared half of
 * the switch — keep it, and wire it when the R2 ingest produces real
 * derivatives. tests/derivatives.test.mts is its only caller today.
 */

import { envString, stripTrailingSlashes } from "./env";

export const WEB_DERIVATIVE_WIDTHS = [750, 1500, 2500] as const;
export type WebDerivativeWidth = (typeof WEB_DERIVATIVE_WIDTHS)[number];

/** Default display source — the middle rung of the ladder. */
export const WEB_DEFAULT_WIDTH: WebDerivativeWidth = 1500;

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
 * Returns null when NEXT_PUBLIC_WEB_IMAGES_BASE is unset.
 * Production must not fall back to any remote host.
 */
export function webDerivativeUrls(slug: string): WebDerivativeUrls | null {
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

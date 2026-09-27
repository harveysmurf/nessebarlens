/**
 * Public gallery derivatives — Squarespace ladder trimmed to three widths.
 * Pre-rendered at ingest into nessebar-lens-web as:
 *   {slug}/750.jpg | {slug}/1500.jpg | {slug}/2500.jpg
 * Never link masters or Image Resizing URLs from the gallery.
 * No third-party image hosts (Unsplash etc.) — missing base → no remote image.
 */

export const WEB_DERIVATIVE_WIDTHS = [750, 1500, 2500] as const;
export type WebDerivativeWidth = (typeof WEB_DERIVATIVE_WIDTHS)[number];

export type WebDerivativeUrls = {
  w750: string;
  w1500: string;
  w2500: string;
  /** Default display source (1500). */
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
  const raw = process.env.NEXT_PUBLIC_WEB_IMAGES_BASE?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

/**
 * Returns null when NEXT_PUBLIC_WEB_IMAGES_BASE is unset.
 * Production must not fall back to any remote host.
 */
export function webDerivativeUrls(slug: string): WebDerivativeUrls | null {
  const base = webImagesBase();
  if (!base) return null;

  const path = (w: WebDerivativeWidth) => `${base}/${slug}/${w}.jpg`;
  const w750 = path(750);
  const w1500 = path(1500);
  const w2500 = path(2500);
  return {
    w750,
    w1500,
    w2500,
    src: w1500,
    srcSet: `${w750} 750w, ${w1500} 1500w, ${w2500} 2500w`,
  };
}

/**
 * The print preview's fixed styling (#326): frame finishes, moulding shading
 * and product shadows, as Records keyed by the catalog unions. A new finish
 * therefore fails to compile here until its colours are written, the same
 * single-source rule the copy records follow.
 *
 * Colours are the real product vocabulary: black/white/brown mouldings, the
 * snow-white mount and the canvas weave. Nothing here is decorative — the
 * preview exists to show what Prodigi prints and frames.
 */
import type { FrameFinish } from "@/domain/pricing/pricing";
import {
  PREVIEW_KINDS,
  type PhysicalPreviewKind,
} from "@/domain/ordering/print-preview";

/** Moulding base colour per finish; a new finish is a compile error here. */
export const FRAME_BASE: Record<FrameFinish, string> = {
  black: "#211f1d",
  white: "#efede8",
  brown: "#5b3a22",
};

/** Profile shading across the moulding thickness, outer edge to inner edge. */
export const FRAME_PROFILE =
  "rgba(255,255,255,.10), rgba(0,0,0,.08) 65%, rgba(0,0,0,.28)";

/** The four moulding sides, named for their side of the frame. */
export type FrameSide = "top" | "right" | "bottom" | "left";

/** Light falling from the top-left, per side of the frame. */
export const FRAME_LIGHT: Record<FrameSide, string> = {
  top: "rgba(255,255,255,.10)",
  left: "rgba(255,255,255,.05)",
  right: "rgba(0,0,0,.12)",
  bottom: "rgba(0,0,0,.20)",
};

/**
 * Brown moulding grain (#332). An inline SVG tile of anisotropic
 * `feTurbulence` fractal noise, mapped to a narrow band of browns around
 * `FRAME_BASE.brown` (#5b3a22): the linear transfer slopes are set so the noise
 * luminance varies that base tone by a few percent either way, never far from
 * real oak.
 *
 * The noise is stretched *along* the grain — `baseFrequency="0.02 1.5"` for a
 * horizontal rail, swapped for a vertical stile — so the streaks run down the
 * length of each piece, across the 20 mm face. The frequency is in viewBox
 * units (≈ moulding millimetres), and the caller stretches the tile to
 * `100% 100%` of the piece, so the grain is sized to the frame, not the screen.
 * `seed` varies per piece so the four mouldings are not copies of one another.
 *
 * No dependency, no asset: one data URI per side. The filter lives *inside* the
 * background image, so it is not a CSS `filter` and does not touch #327's
 * transform context.
 */
export function frameGrain(side: FrameSide, seed: number): string {
  const horizontal = side === "top" || side === "bottom";
  const width = horizontal ? 300 : 20;
  const height = horizontal ? 20 : 300;
  const frequency = horizontal ? "0.02 1.5" : "1.5 0.02";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<filter id="g" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="4" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/>` +
    `<feComponentTransfer>` +
    `<feFuncR type="linear" slope="0.40" intercept="0.157"/>` +
    `<feFuncG type="linear" slope="0.34" intercept="0.058"/>` +
    `<feFuncB type="linear" slope="0.26" intercept="0.003"/>` +
    `<feFuncA type="linear" slope="0" intercept="1"/>` +
    `</feComponentTransfer>` +
    `</filter>` +
    `<rect width="${width}" height="${height}" filter="url(#g)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Per-side turbulence seed: distinct grain on each of the four mouldings. */
export const FRAME_GRAIN_SEED: Record<FrameSide, number> = {
  top: 7,
  right: 23,
  bottom: 41,
  left: 59,
};

/** The four grain data URIs, built once instead of every render (#332). */
export const FRAME_GRAIN_URI: Record<FrameSide, string> = {
  top: frameGrain("top", FRAME_GRAIN_SEED.top),
  right: frameGrain("right", FRAME_GRAIN_SEED.right),
  bottom: frameGrain("bottom", FRAME_GRAIN_SEED.bottom),
  left: frameGrain("left", FRAME_GRAIN_SEED.left),
};

/** The faint 45° mitre joint, drawn over the brown grain (#332). */
export const FRAME_MITRE = "rgba(0,0,0,.18)";

export const MOUNT_BACKGROUND = "#f6f5f1";

export const STAGE_BACKGROUND =
  "radial-gradient(120% 90% at 30% 15%, #f4f0e9 0%, #e7e1d7 60%, #ddd6ca 100%)";

/** Product-box shadow per physical kind. Never a `filter` (it breaks #327). */
export const PRODUCT_SHADOW: Record<PhysicalPreviewKind, string> = {
  [PREVIEW_KINDS.paper]:
    "0 1px 2px rgba(0,0,0,.18), 0 6px 14px rgba(0,0,0,.12)",
  [PREVIEW_KINDS.framed]:
    "0 2px 4px rgba(0,0,0,.28), 0 14px 28px rgba(0,0,0,.20)",
  [PREVIEW_KINDS.canvas]:
    "0 3px 6px rgba(0,0,0,.28), 0 20px 40px rgba(0,0,0,.24)",
};

export const CANVAS_EDGE_SHADOW =
  "inset 0 0 0 1px rgba(0,0,0,.10), inset -2px -2px 4px rgba(0,0,0,.15), inset 2px 2px 3px rgba(255,255,255,.10)";

/** Canvas weave, two perpendicular passes, multiplied over the image. */
export const CANVAS_WEAVE = [
  "repeating-linear-gradient(0deg, rgba(0,0,0,.025) 0 1px, transparent 1px 3px)",
  "repeating-linear-gradient(90deg, rgba(0,0,0,.025) 0 1px, transparent 1px 3px)",
].join(", ");

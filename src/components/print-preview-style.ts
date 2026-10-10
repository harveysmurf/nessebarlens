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

/** Moulding base colour per finish; a new finish is a compile error here. */
export const FRAME_BASE: Record<FrameFinish, string> = {
  black: "#211f1d",
  white: "#efede8",
  brown: "#5b3a22",
};

/** Profile shading across the moulding thickness, outer edge to inner edge. */
export const FRAME_PROFILE =
  "rgba(255,255,255,.10), rgba(0,0,0,.08) 65%, rgba(0,0,0,.28)";

/** Light falling from the top-left, per side of the frame. */
export const FRAME_LIGHT: Record<
  "top" | "right" | "bottom" | "left",
  string
> = {
  top: "rgba(255,255,255,.10)",
  left: "rgba(255,255,255,.05)",
  right: "rgba(0,0,0,.12)",
  bottom: "rgba(0,0,0,.20)",
};

/** Brown-only wood grain stops, running along each piece. */
export const FRAME_GRAIN_STOPS =
  "rgba(30,15,5,.16) 0 1px, transparent 1px 5px";

export const MOUNT_BACKGROUND = "#f6f5f1";

export const STAGE_BACKGROUND =
  "radial-gradient(120% 90% at 30% 15%, #f4f0e9 0%, #e7e1d7 60%, #ddd6ca 100%)";

/** Product-box shadow per physical kind. Never a `filter` (it breaks #327). */
export const PRODUCT_SHADOW: Record<
  "paper" | "framed" | "canvas",
  string
> = {
  paper: "0 1px 2px rgba(0,0,0,.18), 0 6px 14px rgba(0,0,0,.12)",
  framed: "0 2px 4px rgba(0,0,0,.28), 0 14px 28px rgba(0,0,0,.20)",
  canvas: "0 3px 6px rgba(0,0,0,.28), 0 20px 40px rgba(0,0,0,.24)",
};

export const CANVAS_EDGE_SHADOW =
  "inset 0 0 0 1px rgba(0,0,0,.10), inset -2px -2px 4px rgba(0,0,0,.15), inset 2px 2px 3px rgba(255,255,255,.10)";

/** Canvas weave, two perpendicular passes, multiplied over the image. */
export const CANVAS_WEAVE = [
  "repeating-linear-gradient(0deg, rgba(0,0,0,.025) 0 1px, transparent 1px 3px)",
  "repeating-linear-gradient(90deg, rgba(0,0,0,.025) 0 1px, transparent 1px 3px)",
].join(", ");

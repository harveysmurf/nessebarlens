/**
 * The product-preview geometry (#326): for one selection and one master, the
 * rectangles the preview draws, in millimetres, exactly as Prodigi fills the
 * print area.
 *
 * The site sends `sizing: "fillPrintArea"` (prodigi-order.ts), so the photo is
 * scaled to *cover* the product's print area and the overflow is centre-
 * cropped: the buyer sees the trimmed edges. This module is that maths, pure
 * and framework-free, so it can be unit-tested against the reference values in
 * #326.
 *
 * The only size table is the pinned one: print areas come from `findProduct`
 * and `printAreaIn` in ../pricing/print-products, never a second list.
 * Orientation is the master's (#295): a landscape master pairs the product's
 * long edge with the master's long edge, portrait and square pair short with
 * short. Prodigi does not rotate and the site sends a pre-rotated asset
 * (#307), so this pairing is what is printed. Square masters are never offered
 * physical sizes (print-eligibility.ts shape-mismatch), so square needs no
 * special case here; if one arrives it is treated like portrait.
 */

import type { MasterFacts, Orientation } from "../catalog/master-facts";
import type { FrameFinish } from "../pricing/pricing";
import { findProduct, printAreaIn, type PrintProductEntry } from "../pricing/print-products";
import type { PrintSelection } from "./print-selection";

export type Mm = number;
export type Rect = { x: Mm; y: Mm; width: Mm; height: Mm };
export type Extent = { width: Mm; height: Mm };

export type PreviewGeometry =
  | { kind: "digital" }
  | { kind: "paper"; outer: Extent; image: Rect; cropFraction: number }
  | {
      kind: "framed";
      frame: FrameFinish;
      outer: Extent;
      mouldingMm: Mm;
      mount: Rect;
      window: Rect;
      image: Rect;
      cropFraction: number;
    }
  | {
      kind: "canvas";
      front: Extent;
      wrapMm: { x: Mm; y: Mm };
      depthMm: Mm;
      image: Rect;
      cropFraction: number;
    };

/** Face width of a Classic Frame moulding (depth 22 mm). Prodigi Classic Frames range. */
export const CLASSIC_FRAME_MOULDING_MM = 20;
/** Depth of a Stretched Canvas bar. Prodigi Stretched Canvas range. */
export const CANVAS_BAR_DEPTH_MM = 38;

const MM_PER_INCH = 25.4;

/** The product's print area, turned to the master's orientation (long meets long). */
function orientedArea(product: PrintProductEntry, orientation: Orientation): Extent {
  const area = printAreaIn(product);
  const short = area.short * MM_PER_INCH;
  const long = area.long * MM_PER_INCH;
  return orientation === "landscape"
    ? { width: long, height: short }
    : { width: short, height: long };
}

/** The product's nominal size (glaze for framed, front for canvas), oriented. */
function orientedSizeIn(product: PrintProductEntry, orientation: Orientation): Extent {
  const [a, b] = product.sizeIn.split("x").map(Number);
  const short = Math.min(a, b) * MM_PER_INCH;
  const long = Math.max(a, b) * MM_PER_INCH;
  return orientation === "landscape"
    ? { width: long, height: short }
    : { width: short, height: long };
}

/**
 * Scale the master to cover the box and centre it, returning the image rect
 * relative to the box top-left (negative x/y is the centred overflow) and the
 * fraction of the photo discarded by the crop.
 */
function coverCrop(
  box: Extent,
  master: MasterFacts,
): { image: Rect; cropFraction: number } {
  const scale = Math.max(box.width / master.width, box.height / master.height);
  const width = master.width * scale;
  const height = master.height * scale;
  const x = (box.width - width) / 2;
  const y = (box.height - height) / 2;
  const cropFraction = 1 - (box.width * box.height) / (width * height);
  return { image: { x, y, width, height }, cropFraction };
}

/**
 * The geometry for one selection and one master. Digital, and a selection
 * whose product is missing from the table, return `{ kind: "digital" }` — the
 * miss cannot happen for an offered selection, but it must not throw.
 */
export function previewGeometry(
  selection: PrintSelection,
  master: MasterFacts,
): PreviewGeometry {
  const { format, size } = selection;
  if (format === "digital") return { kind: "digital" };

  const product = findProduct(format, size);
  if (!product) return { kind: "digital" };

  const area = orientedArea(product, master.orientation);

  if (format === "giclee") {
    const { image, cropFraction } = coverCrop(area, master);
    return { kind: "paper", outer: area, image, cropFraction };
  }

  if (format === "framed") {
    // `area` is the mount window; the glaze is the nominal sizeIn. The
    // moulding sits outside the glaze, and the window is centred in it.
    const glaze = orientedSizeIn(product, master.orientation);
    const mouldingMm = CLASSIC_FRAME_MOULDING_MM;
    const outer: Extent = {
      width: glaze.width + 2 * mouldingMm,
      height: glaze.height + 2 * mouldingMm,
    };
    const mount: Rect = {
      x: mouldingMm,
      y: mouldingMm,
      width: glaze.width,
      height: glaze.height,
    };
    const window: Rect = {
      x: mouldingMm + (glaze.width - area.width) / 2,
      y: mouldingMm + (glaze.height - area.height) / 2,
      width: area.width,
      height: area.height,
    };
    const { image, cropFraction } = coverCrop(area, master);
    return { kind: "framed", frame: selection.frame, outer, mouldingMm, mount, window, image, cropFraction };
  }

  // Canvas: `area` is the front plus the wrap on each side; the front is the
  // nominal sizeIn. The image is positioned relative to the front face.
  const front = orientedSizeIn(product, master.orientation);
  const wrapMm = {
    x: (area.width - front.width) / 2,
    y: (area.height - front.height) / 2,
  };
  const cover = coverCrop(area, master);
  const image: Rect = {
    x: cover.image.x - wrapMm.x,
    y: cover.image.y - wrapMm.y,
    width: cover.image.width,
    height: cover.image.height,
  };
  return { kind: "canvas", front, wrapMm, depthMm: CANVAS_BAR_DEPTH_MM, image, cropFraction: cover.cropFraction };
}

/**
 * A rect as CSS percentages of a box, four decimals (e.g. `"-6.2500%"`). All
 * positioning in the component goes through this; the component never does mm
 * maths itself.
 */
export function percentRect(
  inner: Rect,
  box: Extent,
): { left: string; top: string; width: string; height: string } {
  return {
    left: percent(inner.x, box.width),
    top: percent(inner.y, box.height),
    width: percent(inner.width, box.width),
    height: percent(inner.height, box.height),
  };
}

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(4)}%`;
}

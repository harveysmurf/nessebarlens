/**
 * The copy behind the print configurator's selectors.
 *
 * FORMATS and FRAMES are keyed off the sku-map lists, never hand-typed here: a
 * hand-typed duplicate of those lists produces a configurator that silently
 * cannot offer a newly pinned Prodigi SKU, with no type error and no test. The
 * size list is the photo's own print offer (#302), in table order — see
 * `sizeOptions`/`offeredFormats` below. The home and story pages already carry
 * partial copies of the same idea.
 *
 * These are Records keyed by the id, not arrays of id/label pairs, which is
 * the whole point: adding a format, size or frame finish to the catalog makes
 * this file a compile error until someone writes the words for it. An array
 * cannot fail to compile in that situation; a Record cannot skip it.
 *
 * The ids are derived from the lists at the bottom, so the selector order
 * follows the catalog rather than a second hand-maintained sequence.
 *
 * Note the titles here are configurator copy and deliberately differ from
 * `pricing.ts` FORMAT_LABELS ("Giclée Fine Art" vs "Giclée Fine Art Print"):
 * one is a button, the other an order line. They are separate vocabularies,
 * not copies of each other, so neither is derived from the other.
 */

import type { MasterFacts, Orientation } from "../catalog/master-facts";
import type { PrintOffer } from "../catalog/print-offer";
import {
  sizeLabel,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "../pricing/pricing";
import { FRAME_FINISHES, SELLABLE_FORMATS } from "../pricing/sku-map";
import { CANVAS_BAR_DEPTH_MM, type PreviewGeometry } from "./print-preview";
import type { PrintSelection } from "./print-selection";

export type FormatCopy = { title: string; sub: string };
export type FormatOption = { id: PrintFormat } & FormatCopy;

const FORMAT_COPY: Record<PrintFormat, FormatCopy> = {
  giclee: { title: "Giclée Fine Art", sub: "Hahnemühle 308gsm" },
  framed: { title: "Framed Print", sub: "Solid Wood Frame" },
  canvas: { title: "Stretched Canvas", sub: "Cotton Canvas" },
  digital: { title: "Digital Copy", sub: "Full Resolution JPG" },
};

const FRAME_COPY: Record<FrameFinish, string> = {
  black: "Matte Black",
  white: "Satin White",
  brown: "Brown Wood",
};

/** One entry per sellable format, in catalog order. */
export const CONFIGURATOR_FORMATS: FormatOption[] = SELLABLE_FORMATS.map(
  (id) => ({ id, ...FORMAT_COPY[id] }),
);

/**
 * The formats the configurator shows for a photo's offer (#302): digital, which
 * is always offered, and each physical format that has at least one offered
 * size. A format with nothing offered is hidden, not shown greyed out, so the
 * buyer never picks a format that cannot be bought.
 */
export function offeredFormats(offer: PrintOffer): FormatOption[] {
  return CONFIGURATOR_FORMATS.filter((option) =>
    option.id === "digital" ? true : offer[option.id].length > 0,
  );
}

/**
 * The offered sizes for a physical format, in table order, labelled for the
 * photo's orientation (#302). Digital carries no size, so it has none.
 */
export function sizeOptions(
  offer: PrintOffer,
  format: PrintFormat,
  orientation: Orientation,
): Array<{ id: PrintSize; label: string }> {
  if (format === "digital") return [];
  return offer[format].map((size) => ({
    id: size,
    label: sizeLabel(size, orientation),
  }));
}

/** The first offered physical size of a format, or `undefined`. */
export function firstOfferedSize(
  offer: PrintOffer,
  format: PrintFormat,
): PrintSize | undefined {
  if (format === "digital") return undefined;
  return offer[format][0];
}

/**
 * The digital copy's delivered pixel size, e.g. `7952 × 5304 px` (#325).
 *
 * The download streams the master file unchanged, so the master's oriented
 * dimensions are exactly the pixels the buyer receives. Formatting lives here
 * rather than in the component so the page, the configurator and any test read
 * the same string from the same `MasterFacts` (#295), never a hand-typed size.
 */
export function masterResolutionLabel(master: MasterFacts): string {
  return `${master.width} × ${master.height} px`;
}

/**
 * The preview's accessible label (#326), keyed by format so a new format is a
 * compile error here. It names the format, the labelled size and, for a framed
 * print, the finish and the white mount.
 */
const PREVIEW_LABEL: Record<
  PrintFormat,
  (alt: string, selection: PrintSelection, orientation: Orientation) => string
> = {
  giclee: (alt, selection, orientation) =>
    `${alt} — giclée fine art print, ${sizeLabel(selection.size, orientation)}`,
  framed: (alt, selection, orientation) =>
    `${alt} — framed print, ${sizeLabel(selection.size, orientation)}, ${FRAME_COPY[selection.frame]} frame with white mount`,
  canvas: (alt, selection, orientation) =>
    `${alt} — stretched canvas, ${sizeLabel(selection.size, orientation)}, image wrapped around the ${CANVAS_BAR_DEPTH_MM} mm edges`,
  digital: (alt) => alt,
};

export function previewLabel(
  alt: string,
  selection: PrintSelection,
  orientation: Orientation,
): string {
  return PREVIEW_LABEL[selection.format](alt, selection, orientation);
}

/**
 * The caption under the stage (#326), keyed by format. It names the product,
 * the labelled size and, for framed, the finish. Digital states the full frame
 * because the whole uncropped photo is shown.
 */
const PREVIEW_CAPTION: Record<
  PrintFormat,
  (selection: PrintSelection, orientation: Orientation) => string
> = {
  giclee: (selection, orientation) =>
    `Giclée Fine Art · ${sizeLabel(selection.size, orientation)}`,
  framed: (selection, orientation) =>
    `Framed Print · ${sizeLabel(selection.size, orientation)} · ${FRAME_COPY[selection.frame]}`,
  canvas: (selection, orientation) =>
    `Stretched Canvas · ${sizeLabel(selection.size, orientation)}`,
  digital: () => "Digital Copy · full frame",
};

export function previewCaption(
  selection: PrintSelection,
  orientation: Orientation,
): string {
  return PREVIEW_CAPTION[selection.format](selection, orientation);
}

/**
 * The note under the caption (#326), or null. Canvas explains the wrap; a
 * paper or framed print whose crop discards at least 1% of the photo says so,
 * because the buyer is seeing a real trim, not a decorative crop.
 */
export function previewNote(geometry: PreviewGeometry): string | null {
  if (geometry.kind === "canvas") {
    return `The outer ${Math.round(geometry.wrapMm.x / 10)} cm of the photo wraps around the sides of the canvas.`;
  }
  if (
    (geometry.kind === "paper" || geometry.kind === "framed") &&
    geometry.cropFraction >= 0.01
  ) {
    return "Prints fill the paper edge to edge, so the photo is trimmed slightly at this size — the preview shows exactly what is printed.";
  }
  return null;
}

/**
 * Fallbacks for the configurator's opening selection.
 *
 * The opening format and size are the photo's first offered ones (#302); these
 * are only reached if an offer has no physical format at all, where the size is
 * unused anyway. They were three literals in the component's useState calls —
 * the last hand-typed catalog values in the file — and are exported so a test
 * can assert they are members of the catalog lists.
 */
export const DEFAULT_PRINT_FORMAT: PrintFormat = "giclee";
export const DEFAULT_PRINT_SIZE: PrintSize = "50x70";
export const DEFAULT_FRAME_FINISH: FrameFinish = "black";

/** One entry per frame finish, in catalog order. */
export const CONFIGURATOR_FRAMES = FRAME_FINISHES.map((id) => ({
  id,
  label: FRAME_COPY[id],
}));

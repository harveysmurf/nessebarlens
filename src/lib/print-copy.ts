/**
 * The copy behind the print configurator's three selectors.
 *
 * The component used to declare its own FORMATS, SIZES and FRAMES arrays. Two
 * of those were hand-typed duplicates of the sku-map lists, so adding a format
 * to the catalog — which is what happens when a Prodigi SKU is pinned —
 * produced a configurator that silently could not offer it, with no type error
 * and no test. The home and story pages already carry partial copies of the
 * same idea.
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

import {
  sizeLabel,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "./pricing";
import { FRAME_FINISHES, PRINT_SIZES, SELLABLE_FORMATS } from "./sku-map";

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

/** One entry per size, in catalog order. The label comes from pricing. */
export const CONFIGURATOR_SIZES = PRINT_SIZES.map((size) => ({
  id: size,
  label: sizeLabel(size),
}));

/**
 * What the configurator opens on.
 *
 * These were two literals in the component's useState calls — the last
 * hand-typed catalog values in the file. A size added or removed would leave
 * the default selecting an option that is not in the list, which React reports
 * as an uncontrolled-to-controlled warning rather than as the configuration
 * error it is. Exported from here so a test can assert they are members.
 */
export const DEFAULT_PRINT_SIZE: PrintSize = "50x70";
export const DEFAULT_FRAME_FINISH: FrameFinish = "black";

/** One entry per frame finish, in catalog order. */
export const CONFIGURATOR_FRAMES = FRAME_FINISHES.map((id) => ({
  id,
  label: FRAME_COPY[id],
}));

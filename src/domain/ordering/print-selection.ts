/**
 * The configurator's selection model (#326): the format, size and frame the
 * buyer has chosen, as one value.
 *
 * Lifting it out of the component makes the selection pure, so the live
 * preview geometry and the configurator read the same three fields, and every
 * transition (changing format, size or frame) is one testable function rather
 * than a set of `useState` setters. It owns no catalog lists: the opening
 * selection and the format switch derive from the photo's own print offer
 * (#302), exactly as the component did before.
 */

import type { PrintOffer } from "../catalog/print-offer";
import type { FrameFinish, PrintFormat, PrintSize } from "../pricing/pricing";
import {
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_PAPER,
  type FramedMount,
  type PrintPaper,
} from "../pricing/print-products";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_SIZE,
  firstOfferedSize,
  offeredFormats,
} from "./print-copy";

export type PrintSelection = {
  format: PrintFormat;
  size: PrintSize;
  frame: FrameFinish;
  /** The framed mount (#335); ignored by every non-framed format. */
  mount: FramedMount;
  /** The giclée paper (#337); ignored by every non-giclée format. */
  paper: PrintPaper;
};

/**
 * The selection the configurator opens on: the photo's first offered format
 * and its first offered size, with the default frame. `offeredFormats` always
 * returns digital (see print-copy), so the list is never empty and the first
 * entry is always present; a fallback format here would be dead code.
 */
export function openingSelection(offer: PrintOffer): PrintSelection {
  const format = offeredFormats(offer)[0]!.id;
  const size = firstOfferedSize(offer, format) ?? DEFAULT_PRINT_SIZE;
  return {
    format,
    size,
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
    paper: DEFAULT_PRINT_PAPER,
  };
}

/**
 * Change format, mirroring the configurator's `selectFormat`: a physical format
 * opens on its own first offered size so the size select never points at a
 * size the format does not sell; digital carries no size, so the size and
 * frame are kept.
 */
export function withFormat(
  selection: PrintSelection,
  offer: PrintOffer,
  format: PrintFormat,
): PrintSelection {
  if (format === "digital") return { ...selection, format };
  const first = firstOfferedSize(offer, format);
  return { ...selection, format, size: first ?? selection.size };
}

export function withSize(
  selection: PrintSelection,
  size: PrintSize,
): PrintSelection {
  return { ...selection, size };
}

export function withFrame(
  selection: PrintSelection,
  frame: FrameFinish,
): PrintSelection {
  return { ...selection, frame };
}

/**
 * Change the framed mount (#335). Like `withFrame`, this only writes the
 * field; the configurator decides whether the choice is offered at the current
 * size and never silently swaps the product.
 */
export function withMount(
  selection: PrintSelection,
  mount: FramedMount,
): PrintSelection {
  return { ...selection, mount };
}

/**
 * Change the giclée paper (#337). Like `withMount`, this only writes the
 * field; the configurator decides whether the choice is offered at the current
 * size (both papers are sold for every giclée size) and never silently swaps
 * the product.
 */
export function withPaper(
  selection: PrintSelection,
  paper: PrintPaper,
): PrintSelection {
  return { ...selection, paper };
}

/**
 * URL <-> PrintSelection (#333): the photo page keeps the buyer's choice in the
 * query string so a specific variation is shareable and deep-linkable.
 *
 * Pure values in and out, so the page is only wiring and a test can exercise
 * the grammar without a browser. Validation is against the photo's own print
 * offer (#302): a param naming a format or size the photo does not sell is
 * ignored and the opening selection's value is used — never an error page. The
 * params are `format`, `size` and `frame`; a digital selection carries only
 * `format`.
 *
 * The canvas angled/front view (#327) is deliberately not encoded. It is a way
 * of looking at the product, not part of what is bought, and a link should
 * reproduce the purchase, not the last rotation of the model. `view` is out.
 */

import type { PrintOffer } from "../catalog/print-offer";
import {
  isFrameFinishValue,
  isPrintSize,
  isSellableFormat,
  type PhysicalFormat,
} from "../pricing/sku-map";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_SIZE,
  firstOfferedSize,
  offeredFormats,
} from "./print-copy";
import {
  openingSelection,
  type PrintSelection,
} from "./print-selection";

/**
 * The selection named by a query string, or the photo's opening selection for
 * every param that is absent or invalid. Each field falls back on its own, so
 * `?size=50x70` with no `format` still picks that size for the opening format.
 */
export function selectionFromParams(
  params: URLSearchParams,
  offer: PrintOffer,
): PrintSelection {
  const opening = openingSelection(offer);

  const format = selectionFormat(params.get("format"), offer) ?? opening.format;

  // Digital sells no size or frame, so those params are ignored rather than
  // rejected. The fields are unread by the configurator and the preview; the
  // defaults keep a digital selection identical whatever the photo's offer.
  if (format === "digital") {
    return {
      format,
      size: DEFAULT_PRINT_SIZE,
      frame: DEFAULT_FRAME_FINISH,
    };
  }

  // The size fallback is the *queried* format's first offered size, not the
  // opening format's: `?format=framed` on a photo whose framed sizes differ must
  // never point the select at a size framed does not sell.
  const size =
    selectionSize(params.get("size"), offer, format) ??
    firstOfferedSize(offer, format) ??
    opening.size;

  const frame =
    format === "framed"
      ? selectionFrame(params.get("frame")) ?? opening.frame
      : opening.frame;

  return { format, size, frame };
}

/**
 * The query string for a selection, with only the params its format has. A
 * digital link is `format=digital` and nothing else; a physical one adds
 * `size`; only framed adds `frame`.
 */
export function selectionToParams(selection: PrintSelection): URLSearchParams {
  const params = new URLSearchParams();
  params.set("format", selection.format);
  if (selection.format !== "digital") params.set("size", selection.size);
  if (selection.format === "framed") params.set("frame", selection.frame);
  return params;
}

/** The offered format named by the param, or null when it is absent or unknown. */
function selectionFormat(
  value: string | null,
  offer: PrintOffer,
): PrintSelection["format"] | null {
  if (value === null || !isSellableFormat(value)) return null;
  return offeredFormats(offer).some((format) => format.id === value)
    ? value
    : null;
}

/** A size the physical format offers, or null when the param is not offered. */
function selectionSize(
  value: string | null,
  offer: PrintOffer,
  format: PhysicalFormat,
): PrintSelection["size"] | null {
  if (value === null || !isPrintSize(value)) return null;
  return offer[format].includes(value) ? value : null;
}

/** A known frame finish, or null when the param is absent or unknown. */
function selectionFrame(value: string | null): PrintSelection["frame"] | null {
  if (value === null || !isFrameFinishValue(value)) return null;
  return value;
}

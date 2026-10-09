import type { FrameFinish, PrintFormat, PrintSize } from "../pricing/pricing";
import { physicalSpecification } from "./print-spec";
import type { PhysicalFormat } from "../pricing/sku-map";
import type { ShipToCountryCode } from "../pricing/ship-to-countries";

/**
 * The client half of the request contract, so it can be unit-tested instead of
 * only exercised in the browser. Both bodies carry the same rules
 * parseQuoteBody/parseCheckoutBody enforce server-side, and neither spells
 * them: a selection becomes body fields by building the PrintSpecification
 * the server parses, so the frame rule has one home instead of one per side.
 * The component keeps the fetch/state wiring and supplies the raw form state;
 * a stale frame selection is dropped rather than sent, which is why the
 * builders read the normalised selection back off the specification rather
 * than pass the selection through.
 */

export type QuoteRequest = {
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  destinationCountryCode: ShipToCountryCode;
};

export type CheckoutRequest = {
  photoSlug: string;
  format: PrintFormat;
  size: PrintSize | null;
  frame: FrameFinish | null;
  destinationCountryCode: ShipToCountryCode | null;
};

/** Digital has no Prodigi quote, so the format is physical by construction. */
export function quoteRequest(
  format: PhysicalFormat,
  size: PrintSize,
  frame: FrameFinish,
  destinationCountryCode: ShipToCountryCode,
): QuoteRequest {
  const spec = physicalSpecification(format, size, frame);
  return {
    format: spec.format,
    size: spec.size,
    frame: spec.frame,
    destinationCountryCode,
  };
}

/**
 * Digital is a download, so it needs neither a size nor a shipping country;
 * both are dropped to null so the parser sees the same shape it validates.
 * That drop is the specification's digital arm, which carries no fields to
 * read back. A physical selection goes through the specification so its frame
 * is projected, not re-decided here.
 */
export function checkoutRequest(
  photoSlug: string,
  format: PrintFormat,
  size: PrintSize,
  frame: FrameFinish,
  destinationCountryCode: ShipToCountryCode,
): CheckoutRequest {
  if (format === "digital") {
    return {
      photoSlug,
      format,
      size: null,
      frame: null,
      destinationCountryCode: null,
    };
  }
  const spec = physicalSpecification(format, size, frame);
  return {
    photoSlug,
    format: spec.format,
    size: spec.size,
    frame: spec.frame,
    destinationCountryCode,
  };
}

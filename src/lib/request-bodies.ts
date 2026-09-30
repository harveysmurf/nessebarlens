import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";
import type { PhysicalFormat } from "./sku-map";
import type { ShipToCountryCode } from "./ship-to-countries";

/**
 * The client half of the request contract, so it can be unit-tested instead of
 * only exercised in the browser. Both bodies encode the same rules
 * parseQuoteBody/parseCheckoutBody enforce server-side -- framed carries a
 * finish, other physical formats omit it, digital omits size and frame -- and
 * these builders are the only place the client spells them. The component
 * keeps the fetch/state wiring and supplies the raw form state; a stale frame
 * selection is dropped rather than sent, which is why the finish is normalised
 * here rather than passed straight through.
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

/**
 * The frame field is only meaningful for framed; sending a finish alongside
 * giclee or canvas is exactly what parseFrame rejects with "frame only allowed
 * when format is framed", so the builder nulls it rather than letting a stale
 * selection reach the API. Shared by both bodies because the rule is one rule.
 */
function frameFor(format: PrintFormat, frame: FrameFinish): FrameFinish | null {
  return format === "framed" ? frame : null;
}

/** Digital has no Prodigi quote, so the format is physical by construction. */
export function quoteRequest(
  format: PhysicalFormat,
  size: PrintSize,
  frame: FrameFinish,
  destinationCountryCode: ShipToCountryCode,
): QuoteRequest {
  return { format, size, frame: frameFor(format, frame), destinationCountryCode };
}

/**
 * Digital is a download, so it needs neither a size nor a shipping country;
 * both are dropped to null so the parser sees the same shape it validates.
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
  return {
    photoSlug,
    format,
    size,
    frame: frameFor(format, frame),
    destinationCountryCode,
  };
}
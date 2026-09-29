import {
  ISO_ALPHA2_PATTERN,
  isShipToCountryCode,
} from "./ship-to-countries";
import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";
import {
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
  SELLABLE_FORMATS,
  formatListLabel,
} from "./sku-map";

export type CheckoutBody = {
  photoSlug: string;
  format: PrintFormat;
  size: PrintSize | null;
  frame: FrameFinish | null;
  destinationCountryCode: string | null;
};

// Allow-lists and their error labels are owned by sku-map, so SKU coverage
// and the message we show on rejection cannot drift from each other.
const FORMATS = SELLABLE_FORMATS;
const FORMAT_LABEL = formatListLabel(SELLABLE_FORMATS);
const SIZE_LABEL = formatListLabel(PRINT_SIZES);
const FRAME_LABEL = formatListLabel(FRAME_FINISHES);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Returns a tagged result rather than string | null | { error }. The old shape
 * mixed a value and an error object in one union, so every caller needed an
 * `"error" in x` test plus a cast back to `string | null` — a cast the
 * compiler could not check, and one more place for a rejection to slip past.
 */
function parseDestinationCountry(raw: unknown): Parsed<string | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string" || !ISO_ALPHA2_PATTERN.test(raw)) {
    return {
      ok: false,
      error: "destinationCountryCode must be a 2-letter ISO code",
    };
  }
  if (!isShipToCountryCode(raw)) {
    return {
      ok: false,
      error:
        "destinationCountryCode must be a Prodigi+Stripe ship-to country",
    };
  }
  return { ok: true, value: raw };
}

export function parseCheckoutBody(raw: unknown): CheckoutBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Invalid JSON body" };
  }
  const body = raw as Record<string, unknown>;
  const photoSlug = body.photoSlug;
  const format = body.format;
  const size = body.size ?? null;
  const frame = body.frame ?? null;
  const destination = parseDestinationCountry(body.destinationCountryCode);
  if (!destination.ok) return { error: destination.error };
  const destinationCountryCode = destination.value;

  if (typeof photoSlug !== "string" || !photoSlug) {
    return { error: "photoSlug required" };
  }
  if (typeof format !== "string" || !FORMATS.includes(format as PrintFormat)) {
    return { error: `format must be ${FORMAT_LABEL}` };
  }
  const fmt = format as PrintFormat;

  if (fmt === "digital") {
    if (size !== null && size !== undefined) {
      return { error: "digital rejects size" };
    }
    if (frame !== null && frame !== undefined) {
      return { error: "digital rejects frame" };
    }
    return {
      photoSlug,
      format: fmt,
      size: null,
      frame: null,
      destinationCountryCode,
    };
  }

  if (typeof size !== "string" || !PRINT_SIZES.includes(size as PrintSize)) {
    return { error: `size required for physical formats (${SIZE_LABEL})` };
  }

  if (fmt === "framed") {
    if (typeof frame !== "string" || !FRAME_FINISHES.includes(frame as FrameFinish)) {
      return { error: `frame required for framed (${FRAME_LABEL})` };
    }
    return {
      photoSlug,
      format: fmt,
      size: size as PrintSize,
      frame: frame as FrameFinish,
      destinationCountryCode,
    };
  }

  if (frame !== null && frame !== undefined) {
    return { error: "frame only allowed when format is framed" };
  }

  return {
    photoSlug,
    format: fmt,
    size: size as PrintSize,
    frame: null,
    destinationCountryCode,
  };
}

export type QuoteBody = {
  format: Exclude<PrintFormat, "digital">;
  size: PrintSize;
  frame: FrameFinish | null;
  destinationCountryCode: string | null;
};

export function parseQuoteBody(raw: unknown): QuoteBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Invalid JSON body" };
  }
  const body = raw as Record<string, unknown>;
  const format = body.format;
  const size = body.size ?? null;
  const frame = body.frame ?? null;
  const destination = parseDestinationCountry(body.destinationCountryCode);
  if (!destination.ok) return { error: destination.error };
  const destinationCountryCode = destination.value;

  if (format === "digital") {
    return { error: "digital has no Prodigi quote" };
  }
  if (
    typeof format !== "string" ||
    !(PHYSICAL_FORMATS as string[]).includes(format)
  ) {
    return { error: `format must be ${formatListLabel(PHYSICAL_FORMATS)}` };
  }
  if (typeof size !== "string" || !PRINT_SIZES.includes(size as PrintSize)) {
    return { error: `size required (${SIZE_LABEL})` };
  }

  const fmt = format as Exclude<PrintFormat, "digital">;
  if (fmt === "framed") {
    if (typeof frame !== "string" || !FRAME_FINISHES.includes(frame as FrameFinish)) {
      return { error: `frame required for framed (${FRAME_LABEL})` };
    }
    return {
      format: fmt,
      size: size as PrintSize,
      frame: frame as FrameFinish,
      destinationCountryCode,
    };
  }

  if (frame !== null && frame !== undefined) {
    return { error: "frame only allowed when format is framed" };
  }

  return {
    format: fmt,
    size: size as PrintSize,
    frame: null,
    destinationCountryCode,
  };
}

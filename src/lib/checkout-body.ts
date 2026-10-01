import {
  ISO_ALPHA2_PATTERN,
  isShipToCountryCode,
} from "./ship-to-countries";
import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";
import {
  type PhysicalFormat,
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
  SELLABLE_FORMATS,
  formatListLabel,
  isFrameFinishValue,
  isPhysicalFormat,
  isPrintSize,
  isSellableFormat,
} from "./sku-map";

type CheckoutBody = {
  photoSlug: string;
  format: PrintFormat;
  size: PrintSize | null;
  frame: FrameFinish | null;
  destinationCountryCode: string | null;
};

// Allow-lists and their error labels are owned by sku-map, so SKU coverage
// and the message we show on rejection cannot drift from each other.
const FORMAT_LABEL = formatListLabel(SELLABLE_FORMATS);
const SIZE_LABEL = formatListLabel(PRINT_SIZES);
const FRAME_LABEL = formatListLabel(FRAME_FINISHES);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The frame rules, which checkout and quote share exactly: framed requires a
 * known finish, every other physical format must omit it. The two bodies
 * diverge on everything else -- digital exists only in checkout, and their
 * size and format messages are worded for their own endpoint -- so this is
 * the only part factored out. Its two error strings are part of the API
 * contract; tests/checkout-body.test.mts pins them for both parsers.
 */
function parseFrame(
  format: PhysicalFormat,
  frame: unknown,
): Parsed<FrameFinish | null> {
  if (format === "framed") {
    if (!isFrameFinishValue(frame)) {
      return { ok: false, error: `frame required for framed (${FRAME_LABEL})` };
    }
    return { ok: true, value: frame };
  }
  if (frame !== null && frame !== undefined) {
    return {
      ok: false,
      error: "frame only allowed when format is framed",
    };
  }
  return { ok: true, value: null };
}

/**
 * Returns a tagged result rather than string | null | { error }. A bare union
 * mixing a value and an error object forces every caller into an
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

/**
 * A checkout/quote body has to be an object, and the rejection is a named
 * constant rather than json-body.ts's "Invalid JSON": that one is a body that
 * would not parse at all, this one parsed to a number, a string or null. The
 * two strings are deliberately different, so this stays here instead of
 * importing the other module's error.
 */
const INVALID_BODY_ERROR = "Invalid JSON body";

/** The object prologue both parsers open with, rejection included. */
function asBody(raw: unknown): Parsed<Record<string, unknown>> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: INVALID_BODY_ERROR };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

export function parseCheckoutBody(raw: unknown): CheckoutBody | { error: string } {
  const opened = asBody(raw);
  if (!opened.ok) return { error: opened.error };
  const body = opened.value;
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
  if (!isSellableFormat(format)) {
    return { error: `format must be ${FORMAT_LABEL}` };
  }
  const fmt = format;

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

  if (!isPrintSize(size)) {
    return { error: `size required for physical formats (${SIZE_LABEL})` };
  }

  const parsedFrame = parseFrame(fmt, frame);
  if (!parsedFrame.ok) return { error: parsedFrame.error };

  return {
    photoSlug,
    format: fmt,
    size,
    frame: parsedFrame.value,
    destinationCountryCode,
  };
}

type QuoteBody = {
  format: Exclude<PrintFormat, "digital">;
  size: PrintSize;
  frame: FrameFinish | null;
  destinationCountryCode: string | null;
};

export function parseQuoteBody(raw: unknown): QuoteBody | { error: string } {
  const opened = asBody(raw);
  if (!opened.ok) return { error: opened.error };
  const body = opened.value;
  const format = body.format;
  const size = body.size ?? null;
  const frame = body.frame ?? null;
  const destination = parseDestinationCountry(body.destinationCountryCode);
  if (!destination.ok) return { error: destination.error };
  const destinationCountryCode = destination.value;

  if (format === "digital") {
    return { error: "digital has no Prodigi quote" };
  }
  if (!isPhysicalFormat(format)) {
    return { error: `format must be ${formatListLabel(PHYSICAL_FORMATS)}` };
  }
  if (!isPrintSize(size)) {
    return { error: `size required (${SIZE_LABEL})` };
  }

  const fmt = format;
  const parsedFrame = parseFrame(fmt, frame);
  if (!parsedFrame.ok) return { error: parsedFrame.error };

  return {
    format: fmt,
    size,
    frame: parsedFrame.value,
    destinationCountryCode,
  };
}

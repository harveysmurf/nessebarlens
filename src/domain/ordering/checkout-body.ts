import {
  ISO_ALPHA2_PATTERN,
  isShipToCountryCode,
  type ShipToCountryCode,
} from "../pricing/ship-to-countries";
import type { FrameFinish, PrintSize } from "../pricing/pricing";
import {
  parsePrintSpecification,
  type PrintSpecificationReason,
} from "./print-spec";
import {
  type PhysicalFormat,
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
  SELLABLE_FORMATS,
  formatListLabel,
  isPhysicalFormat,
  isSellableFormat,
} from "../pricing/sku-map";

/**
 * A checkout body is one of two shapes, told apart by `format`. A digital order
 * has no size or frame; a physical one always does. The union is the type that
 * lets the route branch on `format` and have `size`/`frame`/`destinationCountryCode`
 * narrow without a cast.
 */
export type DigitalCheckout = {
  photoSlug: string;
  format: "digital";
  destinationCountryCode: ShipToCountryCode | null;
};

export type PhysicalCheckout = {
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  destinationCountryCode: ShipToCountryCode | null;
};

export type CheckoutBody = DigitalCheckout | PhysicalCheckout;

// Allow-lists and their error labels are owned by sku-map, so SKU coverage
// and the message we show on rejection cannot drift from each other.
const FORMAT_LABEL = formatListLabel(SELLABLE_FORMATS);
const SIZE_LABEL = formatListLabel(PRINT_SIZES);
const FRAME_LABEL = formatListLabel(FRAME_FINISHES);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The factory's reasons, mapped to the wording this endpoint answers with.
 * The frame pair is shared verbatim by both parsers below: it is one rule and
 * tests/checkout-body.test.mts compares the two bodies case for case, so two
 * spellings would be a divergence the test could only catch by diffing them.
 * Size and digital are worded per endpoint -- which is exactly why the
 * factory returns a reason rather than text a buyer would read.
 */
const DIGITAL_SPEC_ERRORS = {
  "digital-rejects-size": "digital rejects size",
  "digital-rejects-frame": "digital rejects frame",
};

const FRAME_SPEC_ERRORS = {
  "frame-required": `frame required for framed (${FRAME_LABEL})`,
  "frame-not-allowed": "frame only allowed when format is framed",
};

const CHECKOUT_SPEC_ERRORS: Record<PrintSpecificationReason, string> = {
  ...DIGITAL_SPEC_ERRORS,
  ...FRAME_SPEC_ERRORS,
  "size-required": `size required for physical formats (${SIZE_LABEL})`,
};

const QUOTE_SPEC_ERRORS: Record<PrintSpecificationReason, string> = {
  // A quote body is refused as digital before the factory runs, so the two
  // digital entries exist for exhaustiveness and not for a buyer to read.
  ...DIGITAL_SPEC_ERRORS,
  ...FRAME_SPEC_ERRORS,
  "size-required": `size required (${SIZE_LABEL})`,
};

/**
 * Returns a tagged result rather than string | null | { error }. A bare union
 * mixing a value and an error object forces every caller into an
 * `"error" in x` test plus a cast back to `string | null` — a cast the
 * compiler could not check, and one more place for a rejection to slip past.
 */
function parseDestinationCountry(raw: unknown): Parsed<ShipToCountryCode | null> {
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

export function parseCheckoutBody(
  raw: unknown,
): CheckoutBody | { error: string } {
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

  const spec = parsePrintSpecification(format, size, frame);
  if (!spec.ok) return { error: CHECKOUT_SPEC_ERRORS[spec.reason] };
  if (spec.value.kind === "digital") {
    return {
      photoSlug,
      format: "digital",
      destinationCountryCode,
    };
  }

  return {
    photoSlug,
    format: spec.value.format,
    size: spec.value.size,
    frame: spec.value.frame,
    destinationCountryCode,
  };
}

/**
 * A quote body is the physical checkout shape without the photo slug. Defined
 * from the same parser pieces rather than as a union: a quote is never digital,
 * so there is no second arm to discriminate on.
 */
export type QuoteBody = {
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  destinationCountryCode: ShipToCountryCode | null;
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

  const spec = parsePrintSpecification(format, size, frame);
  if (!spec.ok) return { error: QUOTE_SPEC_ERRORS[spec.reason] };

  return {
    format: spec.value.format,
    size: spec.value.size,
    frame: spec.value.frame,
    destinationCountryCode,
  };
}

import { isEu27CountryCode } from "./eu-countries";
import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";

export type CheckoutBody = {
  photoSlug: string;
  format: PrintFormat;
  size: PrintSize | null;
  frame: FrameFinish | null;
  destinationCountryCode: string | null;
};

const FORMATS: PrintFormat[] = ["giclee", "framed", "canvas", "digital"];
const SIZES: PrintSize[] = ["30x40", "50x70", "70x100"];
const FRAMES: FrameFinish[] = ["black", "white", "brown"];

function parseDestinationCountry(
  raw: unknown,
): string | null | { error: string } {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^[A-Z]{2}$/.test(raw)) {
    return { error: "destinationCountryCode must be a 2-letter ISO code" };
  }
  if (!isEu27CountryCode(raw)) {
    return { error: "destinationCountryCode must be an EU-27 country" };
  }
  return raw;
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
  if (destination && typeof destination === "object" && "error" in destination) {
    return destination;
  }
  const destinationCountryCode = destination as string | null;

  if (typeof photoSlug !== "string" || !photoSlug) {
    return { error: "photoSlug required" };
  }
  if (typeof format !== "string" || !FORMATS.includes(format as PrintFormat)) {
    return { error: "format must be giclee|framed|canvas|digital" };
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

  if (typeof size !== "string" || !SIZES.includes(size as PrintSize)) {
    return { error: "size required for physical formats (30x40|50x70|70x100)" };
  }

  if (fmt === "framed") {
    if (typeof frame !== "string" || !FRAMES.includes(frame as FrameFinish)) {
      return { error: "frame required for framed (black|white|brown)" };
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
  if (destination && typeof destination === "object" && "error" in destination) {
    return destination;
  }
  const destinationCountryCode = destination as string | null;

  if (format === "digital") {
    return { error: "digital has no Prodigi quote" };
  }
  if (
    typeof format !== "string" ||
    !(["giclee", "framed", "canvas"] as string[]).includes(format)
  ) {
    return { error: "format must be giclee|framed|canvas" };
  }
  if (typeof size !== "string" || !SIZES.includes(size as PrintSize)) {
    return { error: "size required (30x40|50x70|70x100)" };
  }

  const fmt = format as Exclude<PrintFormat, "digital">;
  if (fmt === "framed") {
    if (typeof frame !== "string" || !FRAMES.includes(frame as FrameFinish)) {
      return { error: "frame required for framed (black|white|brown)" };
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

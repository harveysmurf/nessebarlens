import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";

export type CheckoutBody = {
  photoSlug: string;
  format: PrintFormat;
  size: PrintSize | null;
  frame: FrameFinish | null;
};

const FORMATS: PrintFormat[] = ["giclee", "framed", "canvas", "digital"];
const SIZES: PrintSize[] = ["30x40", "50x70", "70x100"];
const FRAMES: FrameFinish[] = ["black", "white", "brown"];

export function parseCheckoutBody(raw: unknown): CheckoutBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Invalid JSON body" };
  }
  const body = raw as Record<string, unknown>;
  const photoSlug = body.photoSlug;
  const format = body.format;
  const size = body.size ?? null;
  const frame = body.frame ?? null;

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
    return { photoSlug, format: fmt, size: null, frame: null };
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
  };
}

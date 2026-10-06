/**
 * One derivative's pixels, from a master's bytes.
 *
 * Shared by the ingest script (scripts/ingest-derivatives.mjs) and the publish
 * script (#241), so both produce byte-identical output for the same input —
 * the key is the master's content hash, so two generators that disagree would
 * fight over the same object forever.
 *
 * The pixel pipeline, applied to every rung:
 *   - rotate() applies the EXIF orientation first, so the width-driven resize
 *     measures the upright photo;
 *   - toColorspace('srgb') converts from the embedded ICC (Adobe RGB, Display
 *     P3) so browsers show the intended colours;
 *   - resize by width, never enlarging;
 *   - sharp strips EXIF, GPS, XMP and ICC unless asked to keep them, and this
 *     never asks, so the output carries no metadata.
 *
 * sharp is a devDependency and this file is scripts-only: it never reaches the
 * Worker bundle.
 */

import sharp from "sharp";

import {
  DERIVATIVE_JPEG_QUALITY,
  DERIVATIVE_WEBP_QUALITY,
} from "../src/lib/derivative-ladder.ts";

/** The Content-Type for a derivative's format. */
export function derivativeContentType(format) {
  return format === "webp" ? "image/webp" : "image/jpeg";
}

/**
 * Renders one rung as the requested format. `pixels` is the already-clamped
 * width (never larger than the master), so `withoutEnlargement` is belt and
 * braces rather than the only guard.
 */
export async function renderDerivative(bytes, { pixels, format }) {
  const pipeline = sharp(bytes)
    .rotate()
    .toColorspace("srgb")
    .resize({ width: pixels, withoutEnlargement: true });
  if (format === "webp") {
    return pipeline.webp({ quality: DERIVATIVE_WEBP_QUALITY }).toBuffer();
  }
  return pipeline
    .jpeg({ quality: DERIVATIVE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

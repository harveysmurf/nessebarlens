/**
 * One derivative's pixels, from a master's bytes.
 *
 * Shared by scripts/publish-photos.mjs (#241) — its web ladder and the staging
 * master — so both produce byte-identical output for the same input. The web
 * key is the master's content hash, so two generators that disagree would
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
  STAGING_MASTER_JPEG_QUALITY,
  STAGING_MASTER_MAX_EDGE,
} from "../src/domain/catalog/derivative-ladder";

/** The Content-Type for a derivative's format. */
export function derivativeContentType(format) {
  return format === "webp" ? "image/webp" : "image/jpeg";
}

/**
 * The master's pixel size after EXIF orientation, so a portrait phone capture
 * is measured as the viewer sees it. `metadata()` does not apply the rotation,
 * so orientations 5-8 swap the axes here.
 */
export async function masterDimensions(bytes) {
  const meta = await sharp(bytes).metadata();
  let width = meta.width ?? 0;
  let height = meta.height ?? 0;
  if (meta.orientation && meta.orientation >= 5) {
    [width, height] = [height, width];
  }
  return { width, height };
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

/**
 * The staging master (#212): the same srgb + orientation + metadata-stripped
 * pipeline, bounded by the long edge rather than the width, JPEG quality 80.
 * Staging and PR previews read this instead of the original.
 */
export async function renderStagingMaster(bytes) {
  return sharp(bytes)
    .rotate()
    .toColorspace("srgb")
    .resize({
      width: STAGING_MASTER_MAX_EDGE,
      height: STAGING_MASTER_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: STAGING_MASTER_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

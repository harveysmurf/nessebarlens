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
import { printAssetRotation } from "../src/domain/catalog/print-asset";

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

/**
 * The print asset (#307): the only file Prodigi ever receives. The master's
 * EXIF orientation is applied, then a landscape master is turned a further 90°
 * clockwise so it fills the portrait print area (Prodigi does not rotate,
 * #298). Portrait and square masters are not rotated.
 *
 * `autoOrient()` applies the EXIF tag; a second explicit `.rotate()` would
 * replace that rotation rather than compose with it, so the EXIF pass and the
 * #307 turn are one call each, never two `.rotate()`s. The output is sRGB with
 * an embedded sRGB profile and no other metadata — no EXIF, GPS or XMP, and so
 * no orientation tag for Prodigi to reinterpret.
 */
export async function renderPrintAsset(bytes, orientation) {
  let pipeline = sharp(bytes).autoOrient();
  if (printAssetRotation(orientation) !== 0) {
    pipeline = pipeline.rotate(90);
  }
  return pipeline
    .toColorspace("srgb")
    .withIccProfile("srgb")
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/**
 * A crop preview (#300): the master's EXIF orientation applied, then a center
 * crop at the product's print-area ratio, 1200 px on the long edge. This is what
 * the owner reviews before a publish — not an artifact anything reads — so it is
 * a small JPEG and never leaves the gitignored drop folder.
 *
 * `printArea` is the unordered `{ short, long }` inches pair from the pinned
 * table; the ratio is orientation-free, so the crop drops the same pixels as the
 * print fill does.
 */
export async function renderCropPreview(bytes, printArea, longEdge = 1200) {
  const ratio = printArea.long / printArea.short;
  const height = longEdge;
  const width = Math.max(1, Math.round(longEdge / ratio));
  return sharp(bytes)
    .rotate()
    .resize({ width, height, fit: "cover", position: "center" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

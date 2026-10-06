/**
 * The pixel pipeline, run on a committed fixture that carries an Adobe RGB ICC
 * profile and GPS EXIF. What this proves that a plan test cannot: the output is
 * actually re-encoded sRGB with no metadata, at the right width and aspect.
 *
 * The fixture is small so it can live in git; it is real enough to fail if the
 * pipeline stops converting colours or stops stripping metadata.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  derivativeContentType,
  renderDerivative,
} from "../scripts/derivative-image.mjs";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "adobe-rgb-gps.jpg");

test("the fixture really carries an ICC profile and EXIF (or the tests below are vacuous)", async () => {
  const meta = await sharp(FIXTURE).metadata();
  assert.ok(meta.icc, "fixture lost its embedded ICC profile");
  assert.ok(meta.exif, "fixture lost its EXIF (including GPS)");
  assert.equal(meta.width, 500);
  assert.equal(meta.height, 375);
});

test("a JPEG derivative is sRGB, stripped of EXIF/GPS/ICC, at the requested width", async () => {
  const bytes = await readFile(FIXTURE);
  const out = await renderDerivative(bytes, { pixels: 400, format: "jpg" });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.space, "srgb");
  assert.equal(meta.exif, undefined, "EXIF/GPS must be stripped");
  assert.equal(meta.icc, undefined, "no ICC profile should be attached");
  assert.equal(meta.width, 400);
  // 4:3 preserved within a pixel.
  assert.ok(Math.abs((meta.height ?? 0) - 300) <= 1, `height ${meta.height}`);
});

test("a WebP derivative is stripped and at the requested width", async () => {
  const bytes = await readFile(FIXTURE);
  const out = await renderDerivative(bytes, { pixels: 400, format: "webp" });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 400);
  assert.equal(meta.exif, undefined);
});

test("resize never enlarges beyond the master's own width", async () => {
  const bytes = await readFile(FIXTURE);
  const out = await renderDerivative(bytes, { pixels: 2000, format: "jpg" });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 500);
});

test("derivativeContentType maps each format", () => {
  assert.equal(derivativeContentType("jpg"), "image/jpeg");
  assert.equal(derivativeContentType("webp"), "image/webp");
});

/**
 * The placeholder phase is a real, deliberate state, so it gets tests rather
 * than a comment: everything the gallery serves is one committed JPEG per
 * slug, and the only thing that decides which is placeholderPhotoSrc.
 *
 * The last case is the one that matters most. When the derivative ladder is
 * wired up, this file changes behaviour and someone must notice — a test that
 * fails on the day of the switch is the cheapest possible prompt, so it
 * asserts the placeholder shape exactly rather than loosely.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PLACEHOLDER_VERSION,
  placeholderPhotoImage,
  placeholderPhotoSrc,
} from "../src/lib/placeholder-photo.ts";
import { PHOTOS } from "../src/lib/photos.ts";

const root = path.join(import.meta.dirname, "..");

test("every catalog photo resolves to a placeholder that exists on disk", () => {
  for (const photo of PHOTOS) {
    const src = placeholderPhotoSrc(photo.slug);
    assert.ok(src, `no placeholder for ${photo.slug}`);
    const file = path.join(root, "public", "placeholders", `${photo.slug}.jpg`);
    assert.ok(fs.existsSync(file), `missing file for ${photo.slug}: ${file}`);
  }
});

test("the version bump is in the URL so a changed placeholder busts the CDN", () => {
  const src = placeholderPhotoSrc(PHOTOS[0].slug);
  assert.equal(src, `/placeholders/${PHOTOS[0].slug}.jpg?v=${PLACEHOLDER_VERSION}`);
  // If the query ever goes missing the bump silently stops working, which
  // looks identical to "the browser cached it" — the hardest kind of bug.
  assert.ok(src.includes("?v="), `no cache-busting query in ${src}`);
});

test("a slug that could escape the placeholders directory is refused", () => {
  for (const bad of [
    "../secrets",
    "a/b",
    "/absolute",
    "UPPER",
    "trailing-",
    "-leading",
    "double--dash",
    "",
  ]) {
    assert.equal(
      placeholderPhotoSrc(bad),
      null,
      `${JSON.stringify(bad)} should not produce a URL`,
    );
  }
});

test("no srcSet is fabricated: the placeholder phase has no ladder to pick from", () => {
  // A one-rung srcSet would render correctly and imply a responsive ladder
  // that does not exist, which is how the missing ladder stays invisible.
  const image = placeholderPhotoImage(PHOTOS[0].slug);
  assert.ok(image);
  assert.equal(image.srcSet, null);
  assert.equal(placeholderPhotoImage("../escape"), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  PHOTOS,
  categoryHref,
  getPhoto,
  photosByCategory,
  type PhotoCategory,
} from "../src/lib/photos.ts";
import { PHOTO_SLUG_PATTERN, isMasterKey, masterKeyForSlug } from "../src/lib/master-key.ts";

const CATEGORIES: PhotoCategory[] = ["fine-art", "archive", "film"];

test("the catalog is well-formed: unique slugs, valid categories, master keys", () => {
  const slugs = new Set<string>();
  for (const photo of PHOTOS) {
    assert.equal(slugs.has(photo.slug), false, `duplicate slug ${photo.slug}`);
    slugs.add(photo.slug);
    assert.equal(PHOTO_SLUG_PATTERN.test(photo.slug), true, photo.slug);
    assert.equal(CATEGORIES.includes(photo.category), true, photo.category);
    assert.equal(isMasterKey(photo.imageKey), true, photo.imageKey);
    assert.ok(photo.title.length > 0, photo.slug);
    assert.ok(photo.categoryLabel.length > 0, photo.slug);
  }
  // Every category has at least one photo, or its gallery page is empty.
  for (const category of CATEGORIES) {
    assert.ok(photosByCategory(category).length > 0, category);
  }
});

test("getPhoto and photosByCategory agree with the catalog", () => {
  for (const photo of PHOTOS) {
    assert.equal(getPhoto(photo.slug)?.title, photo.title);
  }
  assert.equal(getPhoto("not-a-photo"), undefined);
  assert.equal(getPhoto(""), undefined);
  const all = CATEGORIES.flatMap((category) => photosByCategory(category));
  assert.equal(all.length, PHOTOS.length, "no photo may be in zero or two categories");
  for (const photo of PHOTOS) {
    assert.equal(
      photosByCategory(photo.category).some((p) => p.slug === photo.slug),
      true,
      photo.slug,
    );
  }
});

test("masterKeyForSlug returns the catalog key for every catalog slug", () => {
  for (const photo of PHOTOS) {
    assert.equal(masterKeyForSlug(photo.slug), photo.imageKey, photo.slug);
  }
});

test("categoryHref is a complete map, so a new category cannot render href=undefined", () => {
  assert.equal(categoryHref("fine-art"), "/fine-art");
  assert.equal(categoryHref("archive"), "/archive");
  assert.equal(categoryHref("film"), "/film");
  // Every category the catalog can hold has a route.
  for (const photo of PHOTOS) {
    assert.match(categoryHref(photo.category), /^\/[a-z-]+$/, photo.category);
  }
});

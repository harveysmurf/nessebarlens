import assert from "node:assert/strict";
import test from "node:test";
import {
  PHOTOS,
  categoryHref,
  featuredPhoto,
  getPhoto,
  isFilmPhoto,
  photosByCategory,
} from "../src/lib/photos.ts";
import type { PhotoCategory } from "../src/lib/photo-schema.ts";
import { PHOTO_SLUG_PATTERN, isMasterKey } from "../src/lib/derivative-ladder.ts";
import { masterKeyForSlug } from "../src/lib/master-key.ts";

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

// The dark matte on a gallery tile was hand-written as a `dark` boolean beside
// each tile's copy on the home and story pages, while PhotoCard derived it.
// The derivation is now the only spelling, so the drift it replaces would be
// invisible: a fourth category, or a tile repointed at a photo of another
// category, would render the wrong matte with nothing failing.
test("isFilmPhoto is the category, checked against every photo", () => {
  for (const photo of PHOTOS) {
    assert.equal(
      isFilmPhoto(photo),
      photo.category === "film",
      `${photo.slug} (${photo.category})`,
    );
  }
  // Non-vacuous in both directions: the walk above is a real comparison, not a
  // walk over photos that are all one thing.
  assert.ok(PHOTOS.some((p) => isFilmPhoto(p)), "no film photo to check");
  assert.ok(PHOTOS.some((p) => !isFilmPhoto(p)), "no non-film photo to check");
  // A category added to the union but not handled by the helper must not read
  // as film. Typed as PhotoCategory via a cast, because the point is that a
  // new union member arrives here before anyone updates isFilmPhoto.
  assert.equal(
    isFilmPhoto({ category: "panorama" as PhotoCategory }),
    false,
    "an unhandled new category must not fall into the film matte",
  );
});

test("every film photo carries a film look, so the filter agrees with the matte", () => {
  // isFilmPhoto deliberately reads the category, not the presence of a
  // filmLook, because the matte is a gallery convention and the filter is a
  // rendering one. They coincide today; this test is what makes the
  // coincidence a checked fact instead of an assumption, so the day a film
  // photo ships unfiltered someone sees this fail and can decide whether the
  // matte should follow.
  for (const photo of photosByCategory("film")) {
    assert.ok(photo.filmLook, `${photo.slug} is film with no film look`);
  }
  // And the converse, so the check above cannot pass on an empty category.
  for (const photo of PHOTOS) {
    if (!isFilmPhoto(photo)) {
      assert.equal(photo.filmLook, undefined, `${photo.slug} has a film look`);
    }
  }
  assert.ok(photosByCategory("film").length > 0);
});

// The #239 migration snapshot (the hand-written per-category slug list and the
// total count) was removed in #257: it had to be edited on every publish, which
// a publish PR must not need. What it guarded is covered by the well-formed
// test above: slugs are unique, every category is populated, and every photo is
// in exactly one category. Display order comes from the YAML `order` field and
// is compiled by scripts/build-catalog.mjs, so it is not re-pinned here.

test("every photo has real alt text within the schema limit", () => {
  for (const photo of PHOTOS) {
    assert.ok(photo.alt.length > 0, photo.slug);
    assert.ok(photo.alt.length <= 200, photo.slug);
    assert.ok(photo.caption.length > 0, photo.slug);
    // alt is a one-line description, not the title it used to be.
    assert.notEqual(photo.alt, photo.title, photo.slug);
  }
});

test("featuredPhoto returns the featured photo, else the first fine-art photo", () => {
  assert.equal(featuredPhoto()?.slug, "dawn");
  // No featured flag: the fallback is the first fine-art photo in display order.
  const withoutFeatured = PHOTOS.map((photo) => ({ ...photo, featured: false }));
  assert.equal(featuredPhoto(withoutFeatured)?.slug, "dawn");
  assert.equal(featuredPhoto([]), undefined);
});

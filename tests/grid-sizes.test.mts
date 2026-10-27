/**
 * The `sizes` a photo grid declares, and the two sites that take one.
 *
 * `sizes` is the browser's answer to "how wide will this image be", and it
 * picks a candidate from the srcSet on that answer. The value therefore belongs
 * to the grid — how many columns, and from which breakpoint — and a tile cannot
 * know it: the same tile is a third of the viewport in a three-up grid and
 * two-thirds in a two-up one.
 *
 * The gallery was carrying a string that described a different grid than the
 * one it sits in (`sm:grid-cols-2 lg:grid-cols-3`, but a value that called for
 * one column below 768px and a third above), which is soft tiles at tablet
 * width. The two values are pinned as literals below: a `sizes` string is a
 * performance decision, and a test that passes on a wrong one is worse than no
 * test.
 *
 * The guard is the other half — no component may spell a tile's `sizes` itself,
 * so a third grid cannot arrive with a value nobody wrote down.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  GALLERY_GRID_SIZES,
  HOME_CATEGORY_GRID_SIZES,
  STORY_BLOCK_SIZES,
} from "../src/components/grid-sizes";

function sourceOf(relative: string): string {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("each grid's sizes is the string that grid's columns imply", () => {
  assert.equal(
    GALLERY_GRID_SIZES,
    "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw",
  );
  assert.equal(HOME_CATEGORY_GRID_SIZES, "(max-width: 768px) 100vw, 33vw");
  assert.equal(STORY_BLOCK_SIZES, "(max-width: 768px) 100vw, 60vw");
});

test("a tile's sizes comes from a named grid, never from the call site", () => {
  // Scoped to PhotoTile, because the full-bleed hero on the home page is not a
  // grid tile and spells its own: it is the viewport, so its value is not read
  // off any grid.
  const TILE = /<PhotoTile\b[^>]*>/g;
  const INLINE_SIZE = /sizes="/;
  let tiles = 0;
  for (const relative of [
    "../src/components/PhotoCard.tsx",
    "../src/app/[locale]/page.tsx",
    "../src/app/[locale]/story/page.tsx",
  ]) {
    for (const tag of sourceOf(relative).match(TILE) ?? []) {
      tiles += 1;
      assert.doesNotMatch(
        tag,
        INLINE_SIZE,
        `${relative} spells a tile's sizes itself; take it from grid-sizes`,
      );
    }
  }
  // The walk has to be walking something: all three tiles are named here.
  assert.equal(tiles, 3);
});

test("the grid each constant describes still has the columns it was written for", () => {
  // The constants are named after their grids, so the grids are what they are
  // checked against: a breakpoint that moves without the value moving is the
  // drift this module exists to make impossible to miss.
  assert.match(
    sourceOf("../src/components/GalleryPage.tsx"),
    /sm:grid-cols-2 lg:grid-cols-3/,
    "the gallery grid changed shape; GALLERY_GRID_SIZES is stale",
  );
  assert.match(
    sourceOf("../src/app/[locale]/page.tsx"),
    /md:grid-cols-3/,
    "the home category grid changed shape; HOME_CATEGORY_GRID_SIZES is stale",
  );
  assert.match(
    sourceOf("../src/app/[locale]/story/page.tsx"),
    /md:col-span-7/,
    "the story block changed width; STORY_BLOCK_SIZES is stale",
  );
});
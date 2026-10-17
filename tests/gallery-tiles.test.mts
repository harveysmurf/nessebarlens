/**
 * #409 — gallery tiles must not draw a frame around the image.
 *
 * A photo tile is a fixed-ratio box (`aspect-[4/3]`) holding an
 * `object-cover` image at `w-full h-full`. The image therefore fills the
 * content box exactly, and anything showing past the image edge comes from the
 * box itself. Tailwind's preflight is `box-sizing: border-box`, so padding on
 * that box is *not* absorbed — it shrinks the content box and leaves a ring of
 * the tile's background visible on all four edges.
 *
 * That is exactly what happened on the film pages: `bg-stone-900 p-1` drew a
 * 4px near-black border (`#1c1917`) around every film photo while fine art and
 * archive, which had no padding, showed none. Reported as #409, and fixed by
 * making the cards identical.
 *
 * These assertions read the component source because the tile's markup is
 * about class names and there is no reason to render it — see
 * print-copy.test.mts, which pins PrintConfigurator the same way. What is
 * asserted is the property, not the literal: a future edit that reintroduces
 * the frame by a different spelling still fails. (The repo does have a render
 * harness for assertions that are *about* text; `category-registry.test.mts`
 * uses it, since there the copy itself is the subject.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function sourceOf(relative: string): string {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * The className of the element wrapping the image in each tile.
 *
 * Handles both spellings the tiles use: a static string (a card styled
 * identically for every photo) and a template literal (a tile that still
 * branches). Which one a file uses is itself the assertion in the first test, so
 * the helper returns both parts and lets the caller judge.
 */
function tileWrapper(source: string): { static?: string; dynamic?: string } {
  // Every tile wrapper carries an aspect ratio and clips its overflow; that pair
  // is what makes the box the thing the image is measured against.
  const dynamic = source.match(/className=\{`([^`]*aspect-\[[^`]*overflow-hidden[^`]*)`\}/);
  if (dynamic) return { dynamic: dynamic[1] };

  const literal = source.match(/className="([^"]*aspect-\[[^"]*overflow-hidden[^"]*)"/);
  if (literal) return { static: literal[1] };

  assert.fail("no aspect-ratio tile wrapper found");
}

test("every gallery card is styled identically", () => {
  // The whole of #409. A category branch in this wrapper is the bug, whatever it
  // renders: film used to take `bg-stone-900 p-1` and the other two
  // `bg-stone-200`. Asserting the exact className would be brittle against a
  // legitimate restyle, so this asserts the absence of the decision instead — a
  // static className has no branch to branch on, whichever photo it is given.
  const wrapper = tileWrapper(sourceOf("../src/components/PhotoCard.tsx"));
  assert.equal(
    wrapper.dynamic,
    undefined,
    `PhotoCard's tile wrapper must not branch on the photo: ${wrapper.dynamic}`,
  );
  assert.ok(wrapper.static, "PhotoCard's tile wrapper should be a static className");
});

test("no gallery tile draws a frame with padding", () => {
  // Padding on the tile box is the only thing that can produce this class of
  // bug here, because the image covers the content box exactly. A dark
  // background on its own is fine — it is the letterbox backdrop behind a crop,
  // and it stays hidden unless the image is shorter than the box.
  for (const file of [
    "../src/components/PhotoCard.tsx",
    "../src/app/story/page.tsx",
    "../src/app/page.tsx",
  ]) {
    const wrapper = tileWrapper(sourceOf(file));
    const value = wrapper.static ?? wrapper.dynamic ?? "";
    assert.doesNotMatch(
      value,
      /\bp-\d|\bpx-\d|\bpy-\d|\bpt-\d|\bpb-\d|\bpl-\d|\bpr-\d/,
      `${file} pads the tile wrapper, which draws a frame around the image: ${value}`,
    );
  }
});

test("the film tile backdrop is a letterbox, not a frame", () => {
  // What is left of the film special case after #409: the dark background stays
  // on the home and story tiles because it shows only where `object-cover`
  // crops. The home page has carried it this way since the first commit
  // (30992dd) while the card never did, which is what made the card's copy of it
  // look arbitrary rather than conventional.
  for (const file of ["../src/app/page.tsx", "../src/app/story/page.tsx"]) {
    const wrapper = tileWrapper(sourceOf(file));
    assert.match(
      wrapper.dynamic ?? "",
      /isFilmPhoto\(photo\) \? "bg-stone-900"/,
      `${file} should keep the film letterbox backdrop: ${wrapper.dynamic}`,
    );
  }
});

test("the film look still reaches the image in the card", () => {
  // #409 removed a frame, not the film treatment. The colour filter is applied
  // to the image, so it cannot paint an edge — and if it were dropped, every
  // film photo would render unfiltered with no test failing, which is the same
  // silent-drift class of bug this file exists to catch.
  const source = sourceOf("../src/components/PhotoCard.tsx");
  assert.match(source, /filmLookClass\(photo\.filmLook\)/);
  assert.match(source, /\$\{filmClass\}/);
});
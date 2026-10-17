/**
 * The `.tsx` test loader (#420).
 *
 * Until this existed, every component test in this repo read component *source*
 * and matched on the className text inside it — `gallery-tiles.test.mts` says so
 * in its own header. That works, and it has one large cost: it can only assert
 * things the className contains, and a legitimate restyle edits the test for no
 * reason.
 *
 * These tests assert on rendered markup instead, which is what the loader was for.
 * They are not a rewrite of the source-reading tests — those stay valid and are
 * untouched — so the value of the loader is demonstrated rather than assumed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PhotoCard } from "../src/components/PhotoCard.tsx";
import { webDerivativeUrls } from "../src/infrastructure/media/derivatives.ts";
import { PHOTOS, isFilmPhoto } from "../src/domain/catalog/photos.ts";
import { load } from "./tsx-hooks.mjs";
import { contrast, oklchToHex } from "./contrast.mts";

const BASE = "NEXT_PUBLIC_WEB_IMAGES_BASE";
const BASE_URL = "https://cdn.example.com/g";

const ROOT = new URL("../", import.meta.url);

/** A file in the repo, by repo-relative path. */
function sourceOf(relative: string): string {
  return readFileSync(new URL(relative, ROOT), "utf8");
}

/**
 * The backdrops a tile can choose, and the foregrounds it can pair them with.
 *
 * The two ramps are read from where they are declared rather than written out:
 * `gallery-200` from `globals.css`, which ships a hex, and the two `stone-*`
 * steps from Tailwind's own theme. #424 moved the non-film backdrop from
 * `stone-200` to `gallery-200` and this test's job is to hold the *fallback
 * contrast* on whatever backdrop the tile picked — a hex copied in here would
 * keep passing after the declaration moved, which is the one thing it must not do.
 */
function themeColor(name: string): string {
  const css = sourceOf("src/app/globals.css");
  // The theme aliases the ramp: `@theme` writes `--color-gallery-200:
  // var(--gallery-200)` and `:root` holds the hex. Both hops are followed, so the
  // value here is the one that ships rather than the alias.
  const aliased = css.match(new RegExp(`--color-${name}:\\s*var\\((--[\\w-]+)\\)`));
  if (aliased) {
    const value = css.match(new RegExp(`${aliased[1]}:\\s*(#[0-9a-f]{6})`, "i"));
    assert.ok(value, `${aliased[1]} should be declared as a hex in globals.css`);
    return value[1];
  }
  const oklch = sourceOf("node_modules/tailwindcss/theme.css").match(
    new RegExp(`--color-${name}:\\s*oklch\\(([^)]+)\\)`),
  );
  assert.ok(oklch, `no colour declared for ${name}`);
  const [l, c, h] = oklch[1].split(/\s+/);
  return oklchToHex(
    Number.parseFloat(l) / (l.endsWith("%") ? 100 : 1),
    Number.parseFloat(c),
    Number.parseFloat(h),
  );
}

const STONE: Record<string, string> = {
  "stone-100": themeColor("stone-100"),
  "gallery-200": themeColor("gallery-200"),
  "stone-900": themeColor("stone-900"),
};
const FOREGROUND: Record<string, string> = {
  "stone-100": themeColor("stone-100"),
  "gallery-900": themeColor("gallery-900"),
};

/** Set env for the duration of `fn`, the way `derivatives.test.mts` does. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Without a base the ladder cannot be built and WebPhoto degrades to alt text. */
function renderCard(photo: (typeof PHOTOS)[number]): string {
  return withEnv({ [BASE]: BASE_URL }, () =>
    renderToStaticMarkup(createElement(PhotoCard, { photo })),
  );
}

const filmPhoto = PHOTOS.find((photo) => isFilmPhoto(photo) && photo.filmLook);
const plainPhoto = PHOTOS.find((photo) => !isFilmPhoto(photo) && !photo.filmLook);
assert.ok(filmPhoto, "the catalog needs a film photo with a look");
assert.ok(plainPhoto, "the catalog needs a non-film photo");

/** The className on the element wrapping the image. */
function tileWrapper(html: string): string {
  const match = html.match(/class="([^"]*aspect-\[[^\"]*overflow-hidden[^\"]*)"/);
  assert.ok(match, `no tile wrapper in: ${html.slice(0, 200)}`);
  return match[1];
}

/** The className on the inner `<img>`. */
function imageClasses(html: string): string {
  const match = html.match(/<img[^>]*\sclass="([^"]*)"/);
  assert.ok(match, `no <img> in: ${html.slice(0, 400)}`);
  return match[1];
}

/**
 * The className on the element that stands in for the image when there is none.
 *
 * WebPhoto's fallback is a `<span>` in the tile's place, not an `<img>`, so the
 * two need separate extraction — asking `imageClasses` for it would fail on the
 * `no <img>` that is precisely the condition under test.
 */
function fallbackClasses(html: string): string {
  const match = html.match(/<span class="([^"]*object-cover[^"]*)"/);
  assert.ok(match, `no fallback span in: ${html.slice(0, 400)}`);
  return match[1];
}

test("a .tsx component imports and renders under the test runner", () => {
  // The whole of #420. Before it, this import alone died with
  // ERR_UNKNOWN_FILE_EXTENSION ".tsx".
  const html = renderCard(plainPhoto);
  assert.match(html, new RegExp(`href="/prints/${plainPhoto.slug}"`));
  assert.match(html, new RegExp(`>${plainPhoto.title}<`));
});

test("the rendered image is the derivative ladder, not a bare <img>", () => {
  // Proves the loader produced working JSX all the way down: PictureImg's
  // <picture>, the WebP <source>, and a srcset built from the real photo hash.
  // The expectation is derived inside the same env as the render — the ladder
  // needs the base configured to exist at all.
  withEnv({ [BASE]: BASE_URL }, () => {
    const html = renderToStaticMarkup(createElement(PhotoCard, { photo: plainPhoto }));
    assert.match(html, /<picture/);
    assert.match(html, /<source type="image\/webp"/);
    const expected = webDerivativeUrls(plainPhoto);
    assert.ok(expected, "the test photo needs a buildable ladder");
    assert.ok(
      html.includes(expected.src),
      `the rendered <img> should point at the ladder's src: ${expected.src}`,
    );
  });
});

test("the tile wrapper draws no frame for a film or a non-film photo", () => {
  // #409, asserted by rendering rather than by reading the source. The card was
  // given `bg-stone-900 p-1` for film against `bg-stone-200` for the rest, which
  // drew a 4px frame. A source-reading test can see that there is no branch —
  // only that whatever the className is, it is the same string for both photos.
  //
  // #422 changed that premise, deliberately. The wrapper does branch now, on the
  // letterbox backdrop, because the card had been the odd one out: it hard-coded
  // `bg-stone-200` for every photo while the home and story tiles gave film a
  // dark backdrop. So string equality is no longer the property worth holding.
  // What #409 was actually about is that neither branch pads the box, and the
  // only thing that differs between them is the backdrop colour — which is what
  // this asserts instead.
  const film = tileWrapper(renderCard(filmPhoto));
  const plain = tileWrapper(renderCard(plainPhoto));

  for (const [label, wrapper] of [["film", film], ["plain", plain]] as const) {
    assert.doesNotMatch(
      wrapper,
      /\bp-\d|\bpx-\d|\bpy-\d|\bpt-\d|\bpb-\d|\bpl-\d|\bpr-\d/,
      `the ${label} tile wrapper pads its box, which draws a frame: ${wrapper}`,
    );
  }

  assert.match(film, /bg-stone-900$/, `film tile lost its letterbox backdrop: ${film}`);
  assert.match(plain, /bg-gallery-200$/, `non-film tile gained a dark backdrop: ${plain}`);
  assert.equal(
    film.replace(/bg-[\w-]+$/, ""),
    plain.replace(/bg-[\w-]+$/, ""),
    "the two wrappers should differ only in the backdrop colour",
  );
});

test("the film look reaches the image and not the wrapper", () => {
  const film = imageClasses(renderCard(filmPhoto));
  const plain = imageClasses(renderCard(plainPhoto));
  assert.match(film, /filter grayscale/, `film photo lost its look: ${film}`);
  assert.doesNotMatch(plain, /filter/, `a non-film photo gained a filter: ${plain}`);
  // The filter is on the image, so it cannot paint an edge — the property that
  // made dropping the frame safe in the first place.
  assert.doesNotMatch(tileWrapper(renderCard(filmPhoto)), /filter/);
});

test("the loader leaves .ts to node's own type stripping", async () => {
  // The call, not the consequence: a `.ts` URL is passed straight to the next
  // loader. If it ever started transforming, `scripts/coverage.mjs` loses the
  // guarantee it states in its own header — that nothing sits between the `.ts`
  // and the code V8 sees, which is what makes its line numbers trustworthy.
  const delegated = Symbol("nextLoad");
  const nextLoad = () => ({ format: "module", source: delegated });
  const result = await load("file:///repo/src/domain/catalog/photos.ts", {}, nextLoad);
  assert.equal(result.source, delegated, "a .ts module was transformed instead of delegated");
  assert.ok(
    webDerivativeUrls({ slug: "dawn", imageHash: "abcdef12" }) === null,
    "sanity: derivatives.ts loaded and ran",
  );
});

test("ops scripts do not gain the transpiler", () => {
  // `scripts/register.mjs` is shared with the ops scripts, which have no JSX and
  // no business running a transpiler. The loader is registered from
  // tests/register.mjs only, and this is what stops that being an accident.
  const source = readFileSync(new URL("../scripts/register.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tsx-hooks/);
});

test("a component with no buildable ladder renders its alt text instead", () => {
  // WebPhoto's documented fallback, and the reason a test asserting on the
  // <img> has to set NEXT_PUBLIC_WEB_IMAGES_BASE first.
  const html = withEnv({ [BASE]: undefined }, () =>
    renderToStaticMarkup(createElement(PhotoCard, { photo: plainPhoto })),
  );
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes(plainPhoto.alt), "the alt text should still be rendered");
});

test("the alt-text fallback is readable on whichever backdrop the tile chose", () => {
  // The fallback is a `<span>` holding the photo's alt text, so it inherits the
  // body's `text-gallery-900` — near-black — from whatever surface the tile put
  // behind it. That coupling is invisible in every screenshot, because a photo
  // with a buildable ladder shows an image and the backdrop never shows. It only
  // appears when a photo has none.
  //
  // #422 made it worse before it made it right: the card used to hard-code a
  // light backdrop for every photo, so its fallback was near-black on light and
  // readable. Giving film the dark letterbox it has everywhere else put
  // near-black on near-black — 1.03:1, which is not a colour, it is a hole in the
  // page. The tile now pairs the fallback's text colour with the backdrop it
  // chose, and this asserts the pairing actually clears AA, by computing it.
  for (const [label, photo] of [
    ["film", filmPhoto],
    ["non-film", plainPhoto],
  ] as const) {
    const html = withEnv({ [BASE]: undefined }, () =>
      renderToStaticMarkup(createElement(PhotoCard, { photo })),
    );
    const backdrop = tileWrapper(html).match(/bg-(stone-\d+|gallery-\d+)$/)?.[1];
    assert.ok(backdrop, `the ${label} tile should declare a backdrop`);

    const text = STONE[backdrop as keyof typeof STONE];
    assert.ok(text, `no hex for ${backdrop}`);
    const declared = fallbackClasses(html).match(/\btext-(stone-\d+|gallery-\d+)\b/)?.[1];
    assert.ok(declared, `the ${label} fallback should declare its own text colour`);
    assert.ok(declared in FOREGROUND, `no hex for ${declared}`);

    const ratio = contrast(FOREGROUND[declared as keyof typeof FOREGROUND], text);
    assert.ok(
      ratio >= 4.5,
      `the ${label} alt-text fallback is ${ratio.toFixed(2)}:1 on ${backdrop} — ` +
        `a photo with no image would show alt text nobody can read.`,
    );
  }
});
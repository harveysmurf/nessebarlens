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

const BASE = "NEXT_PUBLIC_WEB_IMAGES_BASE";
const BASE_URL = "https://cdn.example.com/g";

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

test("the tile wrapper is identical for a film and a non-film photo", () => {
  // #409, asserted by rendering rather than by reading the source. The card was
  // given `bg-stone-900 p-1` for film against `bg-stone-200` for the rest, which
  // drew a 4px frame; the fix made the wrapper static. A source-reading test can
  // see that there is no branch — only that whatever the className is, it is the
  // same string for both photos.
  assert.equal(tileWrapper(renderCard(filmPhoto)), tileWrapper(renderCard(plainPhoto)));
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
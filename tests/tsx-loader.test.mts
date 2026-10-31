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

/** Without a base the ladder cannot be built and WebPhoto serves the placeholder JPEG. */
function renderCard(photo: (typeof PHOTOS)[number]): string {
  return withEnv({ [BASE]: BASE_URL }, () =>
    renderToStaticMarkup(createElement(PhotoCard, { photo, locale: "en", printOptions: "Print options" })),
  );
}

const filmPhoto = PHOTOS.find((photo) => isFilmPhoto(photo) && photo.filmLook === "grayscale");
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
  // The card's link carries the locale segment: every public URL is built by
  // the one path helper, so a link without one would be a link to a redirect.
  assert.match(html, new RegExp(`href="/en/prints/${plainPhoto.slug}"`));
  assert.match(html, new RegExp(`>${plainPhoto.title}<`));
});

test("the rendered image is the derivative ladder, not a bare <img>", () => {
  // Proves the loader produced working JSX all the way down: PictureImg's
  // <picture>, the WebP <source>, and a srcset built from the real photo hash.
  // The expectation is derived inside the same env as the render — the ladder
  // needs the base configured to exist at all.
  withEnv({ [BASE]: BASE_URL }, () => {
    const html = renderToStaticMarkup(createElement(PhotoCard, { photo: plainPhoto, locale: "en", printOptions: "Print options" }));
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

test("a component with no buildable ladder renders its placeholder JPEG instead", () => {
  // Placeholder phase: when the ladder can't be built (no base), WebPhoto serves
  // a local /placeholders/{slug}.jpg so the gallery is never empty, rather than
  // degrading to an alt-text span. The alt text is still carried on the img.
  const html = withEnv({ [BASE]: undefined }, () =>
    renderToStaticMarkup(createElement(PhotoCard, { photo: plainPhoto, locale: "en", printOptions: "Print options" })),
  );
  assert.match(
    html,
    new RegExp(`<img[^>]*src="/placeholders/${plainPhoto.slug}.jpg"`),
    `the tile should render its placeholder image`,
  );
  assert.ok(html.includes(plainPhoto.alt), "the alt text should still be rendered");
});

test("the placeholder image renders for both film and non-film photos without a ladder", () => {
  // Without a base the ladder cannot be built, so WebPhoto serves the local
  // placeholder JPEG instead of an alt-text fallback span. The tile still picks
  // its backdrop, but it's invisible behind the placeholder image.
  for (const [label, photo] of [
    ["film", filmPhoto],
    ["non-film", plainPhoto],
  ] as const) {
    const html = withEnv({ [BASE]: undefined }, () =>
      renderToStaticMarkup(createElement(PhotoCard, { photo, locale: "en", printOptions: "Print options" })),
    );
    assert.match(
      html,
      new RegExp(`<img[^>]*src="/placeholders/${photo.slug}.jpg"`),
      `the ${label} tile should render its placeholder image`,
    );
    assert.doesNotMatch(
      html,
      /<span[^>]*object-cover/,
      `the ${label} tile should not render a fallback span`,
    );
  }
});
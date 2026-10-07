/**
 * The gallery image decision (#245): one source, the R2 derivative ladder.
 * These tests pin it, because a rung that 404s looks identical to a missing
 * image in every screenshot anyone takes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { galleryImage } from "../src/lib/gallery-image.ts";
import { WEB_DEFAULT_WIDTH, WEB_DERIVATIVE_WIDTHS } from "../src/lib/derivative-ladder.ts";

const BASE = "NEXT_PUBLIC_WEB_IMAGES_BASE";
const BASE_URL = "https://cdn.example.com/gallery";
const HASH = "abcdef12";
const PHOTO = { slug: "dawn", imageHash: HASH };

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

const ON = { [BASE]: BASE_URL };

test("a published photo is a CDN derivative with jpeg and webp srcSets", () => {
  withEnv(ON, () => {
    const image = galleryImage(PHOTO);
    assert.ok(image);
    assert.equal(
      image.src,
      `https://cdn.example.com/gallery/dawn/${HASH}/${WEB_DEFAULT_WIDTH}.jpg`,
    );
    for (const set of [image.srcSet, image.webpSrcSet]) {
      assert.equal(set.split(", ").length, WEB_DERIVATIVE_WIDTHS.length);
      for (const part of set.split(", ")) {
        assert.match(part, /^\S+ \d+w$/);
      }
    }
  });
});

test("preferred picks the jpeg src rung without narrowing the srcSet", () => {
  withEnv(ON, () => {
    for (const width of WEB_DERIVATIVE_WIDTHS) {
      const image = galleryImage(PHOTO, width);
      assert.ok(image);
      assert.equal(
        image.src,
        `https://cdn.example.com/gallery/dawn/${HASH}/${width}.jpg`,
        `preferred ${width} did not reach the src`,
      );
      assert.equal(image.srcSet.split(", ").length, WEB_DERIVATIVE_WIDTHS.length);
    }
  });
});

test("a preferred rung the ladder does not have falls back to the default", () => {
  withEnv(ON, () => {
    const image = galleryImage(PHOTO, 4000 as never);
    assert.ok(image);
    assert.equal(
      image.src,
      `https://cdn.example.com/gallery/dawn/${HASH}/${WEB_DEFAULT_WIDTH}.jpg`,
    );
  });
});

test("no usable base, or no hash, yields null rather than a URL to a missing file", () => {
  withEnv({ [BASE]: undefined }, () => {
    assert.equal(galleryImage(PHOTO), null);
  });
  withEnv(ON, () => {
    assert.equal(galleryImage({ slug: "dawn" }), null);
  });
});

test("an unusable slug yields null, not a URL to a missing file", () => {
  withEnv(ON, () => {
    assert.equal(galleryImage({ slug: "../escape", imageHash: HASH }), null);
    assert.equal(galleryImage({ slug: "UPPER", imageHash: HASH }), null);
  });
});

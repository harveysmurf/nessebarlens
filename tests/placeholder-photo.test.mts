/**
 * The gallery has two image sources and one gate. These tests pin the
 * decision, not just each source in isolation, because the decision is the
 * thing that breaks a storefront: a rung that 404s looks identical to a
 * missing image in every screenshot anyone takes.
 *
 * The last test in this file is the one that matters most. When the real
 * JPEGs are uploaded and the flag is turned on, this file changes behaviour
 * on purpose — a test that fails on the day of the switch is the cheapest
 * possible prompt to update the callers, rather than discovering later that
 * a prop is dead or a tile is 404ing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PLACEHOLDER_VERSION,
  galleryImage,
  placeholderPhotoSrc,
} from "../src/lib/placeholder-photo.ts";
import { PHOTOS } from "../src/lib/photos.ts";
import { WEB_DEFAULT_WIDTH } from "../src/lib/derivatives.ts";

const root = path.join(import.meta.dirname, "..");
const BASE = "NEXT_PUBLIC_WEB_IMAGES_BASE";
const FLAG = "NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED";

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

/** No ladder, whatever the ambient environment happens to say. */
const PLACEHOLDER_ONLY = { [BASE]: undefined, [FLAG]: undefined };
/** Ladder on, pointing at an unreachable-but-well-formed CDN. */
const LADDER_ON = {
  [BASE]: "https://cdn.example.com/gallery",
  [FLAG]: "true",
};

test("every catalog photo resolves to a placeholder that exists on disk", () => {
  withEnv(PLACEHOLDER_ONLY, () => {
    for (const photo of PHOTOS) {
      const src = placeholderPhotoSrc(photo.slug);
      assert.ok(src, `no placeholder for ${photo.slug}`);
      const file = path.join(root, "public", "placeholders", `${photo.slug}.jpg`);
      assert.ok(fs.existsSync(file), `missing file for ${photo.slug}: ${file}`);
    }
  });
});

test("the version bump is in the URL so a changed placeholder busts the CDN", () => {
  withEnv(PLACEHOLDER_ONLY, () => {
    const src = placeholderPhotoSrc(PHOTOS[0].slug);
    assert.equal(src, `/placeholders/${PHOTOS[0].slug}.jpg?v=${PLACEHOLDER_VERSION}`);
    // If the query ever goes missing the bump silently stops working, which
    // looks exactly like "the browser cached it" — the hardest kind of bug.
    assert.ok(src.includes("?v="), `no cache-busting query in ${src}`);
  });
});

test("a slug that could escape the placeholders directory is refused", () => {
  withEnv(PLACEHOLDER_ONLY, () => {
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
});

test("a base URL without the flag serves placeholders, not 404s", () => {
  // This is the live production configuration today: the base is set, the
  // buckets are empty. Every photo must still render.
  withEnv({ [BASE]: "https://cdn.example.com/gallery", [FLAG]: undefined }, () => {
    const image = galleryImage(PHOTOS[0].slug);
    assert.ok(image);
    assert.equal(image.source, "placeholder");
    assert.equal(image.src, `/placeholders/${PHOTOS[0].slug}.jpg?v=${PLACEHOLDER_VERSION}`);
  });
});

test("with the ladder on, the image is a CDN derivative with a real srcSet", () => {
  withEnv(LADDER_ON, () => {
    const slug = PHOTOS[0].slug;
    const image = galleryImage(slug);
    assert.ok(image);
    assert.equal(image.source, "ladder");
    assert.equal(
      image.src,
      `https://cdn.example.com/gallery/${slug}/${WEB_DEFAULT_WIDTH}.jpg`,
    );
    // A one-rung srcSet would render correctly and imply a responsive ladder
    // that does not exist, which is how a missing ladder stays invisible.
    assert.ok(image.srcSet, "ladder images need a srcSet");
    assert.equal(image.srcSet.split(", ").length, 3);
    for (const part of image.srcSet.split(", ")) {
      assert.match(part, /^\S+ \d+w$/);
    }
  });
});

test("an unusable slug yields null in both modes, not a URL to a missing file", () => {
  for (const env of [PLACEHOLDER_ONLY, LADDER_ON]) {
    withEnv(env, () => {
      assert.equal(galleryImage("../escape"), null, JSON.stringify(env));
      assert.equal(galleryImage("UPPER"), null, JSON.stringify(env));
    });
  }
});

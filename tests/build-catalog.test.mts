/**
 * The codegen's two jobs, run the way the build runs them: sort a valid
 * directory into the generated module, and refuse a directory with problems by
 * reporting every one of them in a single pass.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { buildCatalog } from "../scripts/build-catalog.mjs";

const BASE = {
  title: "A Title",
  caption: "A Caption",
  description: "A description.",
  alt: "A one-line description of the image",
  category: "fine-art",
};

function withTmpDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "build-catalog-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePhoto(photosDir: string, slug: string, body: Record<string, unknown>) {
  mkdirSync(photosDir, { recursive: true });
  writeFileSync(
    path.join(photosDir, `${slug}.yaml`),
    stringify({ slug, ...body }, { lineWidth: 0 }),
  );
}

test("a valid directory is sorted by category then order and written out", () => {
  withTmpDir((dir) => {
    const photosDir = path.join(dir, "photos");
    const outFile = path.join(dir, "generated", "catalog.ts");
    writePhoto(photosDir, "b", { ...BASE, category: "archive", order: 2 });
    writePhoto(photosDir, "a", { ...BASE, order: 1 });
    writePhoto(photosDir, "c", { ...BASE });

    const result = buildCatalog({ photosDir, outFile });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.photos.map((photo) => photo.slug),
      ["a", "c", "b"],
      "ordered fine-art first (ordered before unordered), then archive",
    );

    const written = readFileSync(outFile, "utf8");
    assert.match(written, /export const PHOTOS: readonly PhotoFile\[\] = Object\.freeze\(/);
    // The written file carries the sorted order, not the read order.
    assert.ok(
      written.indexOf('"slug": "a"') < written.indexOf('"slug": "c"'),
      "generated order does not match the sort",
    );
    assert.ok(written.indexOf('"slug": "c"') < written.indexOf('"slug": "b"'));
  });
});

test("unpublished photos are left out of the generated catalog", () => {
  withTmpDir((dir) => {
    const photosDir = path.join(dir, "photos");
    const outFile = path.join(dir, "catalog.ts");
    writePhoto(photosDir, "shown", { ...BASE });
    writePhoto(photosDir, "hidden", { ...BASE, published: false });

    const result = buildCatalog({ photosDir, outFile });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.photos.map((photo) => photo.slug),
      ["shown"],
    );
    assert.doesNotMatch(readFileSync(outFile, "utf8"), /"slug": "hidden"/);
  });
});

test("more than one published featured photo is refused", () => {
  withTmpDir((dir) => {
    const photosDir = path.join(dir, "photos");
    const outFile = path.join(dir, "catalog.ts");
    writePhoto(photosDir, "first", {
      ...BASE,
      featured: true,
      hero_caption: "One",
    });
    writePhoto(photosDir, "second", {
      ...BASE,
      featured: true,
      hero_caption: "Two",
    });

    const result = buildCatalog({ photosDir, outFile });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p.includes("at most one")),
      result.problems.join("; "),
    );
    assert.equal(existsSync(outFile), false, "a bad catalog must not be written");
  });
});

test("one run reports every problem across every bad file", () => {
  withTmpDir((dir) => {
    const photosDir = path.join(dir, "photos");
    const outFile = path.join(dir, "catalog.ts");
    writePhoto(photosDir, "one", { ...BASE, title: "" });
    writePhoto(photosDir, "two", { ...BASE, category: "panorama" });
    // Not even valid YAML: still reported, not thrown out of the run.
    mkdirSync(photosDir, { recursive: true });
    writeFileSync(path.join(photosDir, "three.yaml"), "title: [unclosed\n");

    const result = buildCatalog({ photosDir, outFile });
    assert.equal(result.ok, false);
    const joined = result.problems.join("\n");
    assert.match(joined, /^one\.yaml: title:/m);
    assert.match(joined, /^two\.yaml: category:/m);
    assert.match(joined, /^three\.yaml: /m);
    assert.equal(existsSync(outFile), false);
  });
});

test("an empty directory yields an empty catalog, not an error", () => {
  withTmpDir((dir) => {
    const photosDir = path.join(dir, "photos");
    const outFile = path.join(dir, "catalog.ts");
    mkdirSync(photosDir, { recursive: true });
    const result = buildCatalog({ photosDir, outFile });
    assert.equal(result.ok, true);
    assert.deepEqual(result.photos, []);
    assert.match(readFileSync(outFile, "utf8"), /Object\.freeze\(\n\[\]\n\);/);
  });
});

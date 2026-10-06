import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertMasterIsUsable,
  assertRungList,
  assertUploadIsSafe,
  imageHash,
  planDerivatives,
  slugFromDroppedName,
  webDerivativeKey,
} from "../src/lib/derivative-ladder.ts";
import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  slugFromMasterKey,
} from "../src/lib/derivative-ladder.ts";

const RUNGS = [400, 750, 1500, 2000];
const HASH = "abcdef12";

function plan(drops, rungs = RUNGS) {
  return planDerivatives(drops, rungs);
}

test("a dropped file declares the slug it is named for", () => {
  assert.equal(slugFromDroppedName("alley-cat.jpg"), "alley-cat");
  assert.equal(slugFromDroppedName("fishermen.jpg"), "fishermen");
  // Not catalog slugs: reported by name rather than uploaded as unlinkable photos.
  assert.equal(slugFromDroppedName("IMG_4021.jpg"), null);
  assert.equal(slugFromDroppedName("Alley-Cat.jpg"), null);
  assert.equal(slugFromDroppedName("alley_cat.jpg"), null);
  assert.equal(slugFromDroppedName("alley-cat.png"), null);
  assert.equal(slugFromDroppedName("prints/alley-cat.jpg"), null);
  assert.equal(slugFromDroppedName(".DS_Store"), null);
  assert.equal(slugFromDroppedName(""), null);
});

test("slugFromMasterKey accepts a master key and rejects anything else", () => {
  assert.equal(slugFromMasterKey("prints/fishermen.jpg"), "fishermen");
  assert.equal(slugFromMasterKey("fishermen.jpg"), null);
  assert.equal(slugFromMasterKey("prints/Fishermen.jpg"), null);
  assert.equal(slugFromMasterKey("prints/../fishermen.jpg"), null);
  assert.equal(slugFromMasterKey("prints/fishermen.png"), null);
  assert.equal(slugFromMasterKey("previews/prints/x.jpg"), null);
});

test("webDerivativeKey is the only place a derivative key is spelled", () => {
  assert.equal(
    webDerivativeKey("fishermen", HASH, 1500, "jpg"),
    `fishermen/${HASH}/1500.jpg`,
  );
  assert.equal(
    webDerivativeKey("fishermen", HASH, 400, "webp"),
    `fishermen/${HASH}/400.webp`,
  );
});

test("imageHash is the first 8 hex of SHA-256, stable and content-sensitive", async () => {
  const bytes = new TextEncoder().encode("the same master bytes");
  const hash = await imageHash(bytes);
  assert.match(hash, /^[0-9a-f]{8}$/);
  assert.equal(await imageHash(bytes), hash, "same bytes must hash the same");
  assert.notEqual(
    await imageHash(new TextEncoder().encode("different bytes")),
    hash,
    "different bytes must hash differently",
  );
});

test("a master below the top rung is refused", () => {
  assert.throws(() => assertMasterIsUsable(1999), /floor is 2000px/);
  assert.throws(() => assertMasterIsUsable(0), /floor is 2000px/);
  assert.throws(() => assertMasterIsUsable(2000.5), /master is 2000\.5px wide/);
  assert.doesNotThrow(() => assertMasterIsUsable(2000));
  assert.doesNotThrow(() => assertMasterIsUsable(4000));
});

test("one master upload and jpg+webp per rung, keyed by the content hash", () => {
  const { masters, jobs, notes, ignoredNames } = plan([
    { name: "fishermen.jpg", width: 4000, hash: HASH },
  ]);
  assert.deepEqual(masters, [
    { slug: "fishermen", key: "prints/fishermen.jpg" },
  ]);
  assert.equal(jobs.length, 8);
  assert.deepEqual(ignoredNames, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(
    jobs.map((job) => job.key),
    [
      `fishermen/${HASH}/400.jpg`,
      `fishermen/${HASH}/400.webp`,
      `fishermen/${HASH}/750.jpg`,
      `fishermen/${HASH}/750.webp`,
      `fishermen/${HASH}/1500.jpg`,
      `fishermen/${HASH}/1500.webp`,
      `fishermen/${HASH}/2000.jpg`,
      `fishermen/${HASH}/2000.webp`,
    ],
  );
  for (const job of jobs) {
    assert.equal(job.slug, "fishermen");
    assert.equal(job.sourceName, "fishermen.jpg");
    assert.equal(job.hash, HASH);
    assert.equal(job.pixels, job.rung);
    assert.ok(job.format === "jpg" || job.format === "webp");
  }
});

test("every advertised rung key is written, clamped to the master's own width", () => {
  const { jobs, notes } = plan([{ name: "small.jpg", width: 1200, hash: HASH }]);
  // One job per width per format; the clamped pixels repeat across formats.
  assert.deepEqual(
    jobs.map((job) => [job.rung, job.pixels, job.format]),
    [
      [400, 400, "jpg"],
      [400, 400, "webp"],
      [750, 750, "jpg"],
      [750, 750, "webp"],
      [1500, 1200, "jpg"],
      [1500, 1200, "webp"],
      [2000, 1200, "jpg"],
      [2000, 1200, "webp"],
    ],
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /small: master is 1200px wide, 2 rung\(s\)/);
});

test("a master narrower than the smallest rung still gets every key", () => {
  const { jobs } = plan([{ name: "tiny.jpg", width: 400, hash: HASH }]);
  assert.equal(jobs.length, 8);
  assert.deepEqual(
    [...new Set(jobs.map((job) => job.pixels))],
    [400],
  );
});

test("files that are not named {slug}.jpg are ignored, not uploaded", () => {
  const { masters, jobs, ignoredNames } = plan([
    { name: "ok.jpg", width: 2000, hash: HASH },
    { name: "README.txt", width: 2000, hash: HASH },
    { name: "Bad-Name.jpg", width: 2000, hash: HASH },
  ]);
  assert.deepEqual(ignoredNames, ["README.txt", "Bad-Name.jpg"]);
  assert.equal(masters.length, 1);
  assert.equal(jobs.length, 8);
});

test("two files claiming one slug fail the run rather than overwriting", () => {
  assert.throws(
    () => plan([
      { name: "alley-cat.jpg", width: 2000, hash: HASH },
      { name: "alley-cat.jpg", width: 2000, hash: HASH },
    ]),
    /two dropped masters declare the slug alley-cat/,
  );
});

test("a master with no readable width fails loudly rather than writing garbage", () => {
  assert.throws(
    () => plan([{ name: "x.jpg", width: 0, hash: HASH }]),
    /no usable width: 0/,
  );
  assert.throws(
    () => plan([{ name: "x.jpg", width: 12.5, hash: HASH }]),
    /no usable width: 12\.5/,
  );
});

test("the rung list must be non-empty, positive, integral and ascending", () => {
  assert.throws(() => assertRungList([]), /empty/);
  assert.throws(() => assertRungList([750, 0]), /not a positive integer: 0/);
  assert.throws(() => assertRungList([750, -1]), /not a positive integer: -1/);
  assert.throws(() => assertRungList([750, 750.5]), /not a positive integer: 750\.5/);
  assert.throws(() => assertRungList([1500, 750]), /strictly ascend/);
  assert.throws(() => assertRungList([750, 1500, 1500]), /strictly ascend/);
  assert.throws(() => plan([], []), /empty/);
  assert.doesNotThrow(() => assertRungList(RUNGS));
});

test("an upload is refused when a bucket is not one we own", () => {
  // Both masters buckets are legitimate: production (promote) and staging.
  for (const mastersBucket of [MASTERS_BUCKET_NAME, STAGING_MASTERS_BUCKET_NAME]) {
    assert.doesNotThrow(() =>
      assertUploadIsSafe({ mastersBucket, webBucket: WEB_BUCKET_NAME }),
    );
  }
  assert.throws(
    () =>
      assertUploadIsSafe({
        mastersBucket: MASTERS_BUCKET_NAME,
        webBucket: "nessebar-lens-masters",
      }),
    /web bucket must be nessebar-lens-web/,
  );
  assert.throws(
    () =>
      assertUploadIsSafe({
        mastersBucket: "nessebar-lens-web",
        webBucket: WEB_BUCKET_NAME,
      }),
    /masters bucket must be/,
  );
});

test("the drop folder is gitignored, so masters never reach a commit", () => {
  const gitignore = readFileSync(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(gitignore, /^\/ingest\/$/m);
});

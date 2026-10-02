import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertRungList,
  assertUploadIsSafe,
  derivativeKey,
  planDerivatives,
  slugFromDroppedName,
} from "../src/lib/derivative-ladder.ts";
import {
  MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  slugFromMasterKey,
} from "../src/lib/derivative-ladder.ts";

const RUNGS = [750, 1500, 2500];

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

test("one master upload and one job per rung, keyed the way the srcSet asks", () => {
  const { masters, jobs, notes, ignoredNames } = plan([
    { name: "fishermen.jpg", width: 4000 },
  ]);
  assert.deepEqual(masters, [
    { slug: "fishermen", key: "prints/fishermen.jpg" },
  ]);
  assert.equal(jobs.length, 3);
  assert.deepEqual(ignoredNames, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(
    jobs.map((job) => job.key),
    ["fishermen/750.jpg", "fishermen/1500.jpg", "fishermen/2500.jpg"],
  );
  for (const job of jobs) {
    assert.equal(job.slug, "fishermen");
    assert.equal(job.sourceName, "fishermen.jpg");
    assert.equal(job.pixels, job.rung);
  }
});

test("every advertised rung key is written, clamped to the master's own width", () => {
  const { jobs, notes } = plan([{ name: "small.jpg", width: 1200 }]);
  assert.deepEqual(
    jobs.map((job) => [job.rung, job.pixels]),
    [
      [750, 750],
      [1500, 1200],
      [2500, 1200],
    ],
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /small: master is 1200px wide, 2 rung\(s\)/);
});

test("a master exactly one rung wide stores that rung unchanged", () => {
  const { jobs, notes } = plan([{ name: "exact.jpg", width: 1500 }]);
  assert.deepEqual(jobs.map((job) => job.pixels), [750, 1500, 1500]);
  assert.equal(notes.length, 1);
});

test("a master narrower than the smallest rung still gets every key", () => {
  const { jobs } = plan([{ name: "tiny.jpg", width: 400 }]);
  assert.deepEqual(jobs.map((job) => job.pixels), [400, 400, 400]);
});

test("files that are not named {slug}.jpg are ignored, not uploaded", () => {
  const { masters, jobs, ignoredNames } = plan([
    { name: "ok.jpg", width: 2000 },
    { name: "README.txt", width: 2000 },
    { name: "Bad-Name.jpg", width: 2000 },
  ]);
  assert.deepEqual(ignoredNames, ["README.txt", "Bad-Name.jpg"]);
  assert.equal(masters.length, 1);
  assert.equal(jobs.length, 3);
});

test("two files claiming one slug fail the run rather than overwriting", () => {
  assert.throws(
    () => plan([
      { name: "alley-cat.jpg", width: 2000 },
      { name: "alley-cat.jpg", width: 2000 },
    ]),
    /two dropped masters declare the slug alley-cat/,
  );
});

test("a master with no readable width fails loudly rather than writing garbage", () => {
  assert.throws(
    () => plan([{ name: "x.jpg", width: 0 }]),
    /no usable width: 0/,
  );
  assert.throws(
    () => plan([{ name: "x.jpg", width: 12.5 }]),
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

test("derivativeKey is the only place a rung key is spelled", () => {
  assert.equal(derivativeKey("fishermen", 1500), "fishermen/1500.jpg");
});

test("an upload is refused when the buckets are not the pair we own", () => {
  const ok = {
    mastersBucket: MASTERS_BUCKET_NAME,
    webBucket: WEB_BUCKET_NAME,
    ladderEnabled: false,
  };
  assert.doesNotThrow(() => assertUploadIsSafe(ok));
  assert.throws(
    () => assertUploadIsSafe({ ...ok, webBucket: "nessebar-lens-masters" }),
    /web bucket must be nessebar-lens-web/,
  );
  assert.throws(
    () => assertUploadIsSafe({ ...ok, mastersBucket: "nessebar-lens-web" }),
    /masters bucket must be nessebar-lens-masters/,
  );
});

test("an upload is refused while the ladder is on and serving that bucket", () => {
  assert.throws(
    () =>
      assertUploadIsSafe({
        mastersBucket: MASTERS_BUCKET_NAME,
        webBucket: WEB_BUCKET_NAME,
        ladderEnabled: true,
      }),
    /already serving this bucket/,
  );
});

test("the ingest script and the shared plan agree on the keys and buckets", () => {
  const script = readFileSync(
    new URL("../scripts/ingest-derivatives.mjs", import.meta.url),
    "utf8",
  );
  // Buckets are referenced through the shared constants, never spelled in
  // code. Comments may name them — the header documents the flow.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("nessebar-lens-web"), "no hardcoded bucket name");
  assert.ok(!code.includes("nessebar-lens-masters"), "no hardcoded bucket name");
  assert.ok(code.includes("const DROP_DIR = \"ingest\""));
  assert.ok(
    !/1500|2500|750/.test(
      script.split("const DROP_DIR")[0] ?? "",
    ),
    "no rung width hardcoded in the script",
  );
  // Dry run is the default: uploading must be an explicit opt-in.
  assert.ok(script.includes('process.argv.includes("--apply")'));
});

test("the drop folder is gitignored, so masters never reach a commit", () => {
  const gitignore = readFileSync(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(gitignore, /^\/ingest\/$/m);
});

/* #108: `--only cat` used substring matching, so it picked up alley-cat.jpg and
   any other name containing "cat", and the script never checked the slug against
   the catalog at all. */

test("--only matches whole slugs, not substrings", async () => {
  const { selectDrops, parseOnly } = await import(
    "../scripts/ingest-derivatives.mjs"
  );
  const names = [
    "alley-cat.jpg",
    "cat.jpg",
    "cathedral.jpg",
    "seagulls.jpg",
  ];
  assert.deepEqual(selectDrops(names, parseOnly("cat")), ["cat.jpg"]);
  assert.deepEqual(selectDrops(names, parseOnly("alley-cat")), ["alley-cat.jpg"]);
  assert.deepEqual(selectDrops(names, parseOnly("cat,seagulls")), [
    "cat.jpg",
    "seagulls.jpg",
  ]);
  assert.deepEqual(selectDrops(names, undefined), names);
});

test("an unknown --only slug is reported before anything is read or written", async () => {
  const { unknownSlugs } = await import("../scripts/ingest-derivatives.mjs");
  const { PHOTOS } = await import("../src/lib/photos.ts");
  const catalog = PHOTOS.map((photo) => photo.slug);
  assert.deepEqual(unknownSlugs(["alley-cat"], catalog), []);
  assert.deepEqual(
    unknownSlugs(["alley-cat", "cathedrall", "dawn"], catalog),
    ["cathedrall"],
  );
  assert.ok(catalog.includes("alley-cat") && catalog.includes("dawn"));
});

test("the catalog check reads the real catalog, not a copy", async () => {
  const script = readFileSync(
    new URL("../scripts/ingest-derivatives.mjs", import.meta.url),
    "utf8",
  );
  assert.match(script, /import \{ PHOTOS \} from "\.\.\/src\/lib\/photos\.ts"/);
  // The substring match is the actual bug; refuse it by name.
  assert.doesNotMatch(script, /name\.includes\(only\)/);
});

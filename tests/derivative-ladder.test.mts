import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertUploadIsSafe,
  slugFromDroppedName,
  webDerivativeKey,
} from "../src/lib/derivative-ladder.ts";
import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  slugFromMasterKey,
} from "../src/lib/derivative-ladder.ts";

const HASH = "abcdef12";

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

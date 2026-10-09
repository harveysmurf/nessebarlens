/**
 * verify-masters (#243): the release gate that refuses to deploy production
 * when a published photo's full-res master is missing or differs from the
 * catalog. The S3 client is injected as a fake, so the decision is tested
 * without a bucket.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MASTERS_BUCKET_NAME } from "../src/domain/catalog/derivative-ladder.ts";
import {
  createMastersS3,
  main,
  metadataValue,
  photosToVerify,
  verifyMasters,
} from "../scripts/verify-masters.mjs";

const ENV = {
  R2_S3_ENDPOINT: "https://r2.example.com",
  R2_MASTERS_READ_ACCESS_KEY_ID: "key",
  R2_MASTERS_READ_SECRET_ACCESS_KEY: "secret",
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A fake masters bucket: `{ "prints/dawn.jpg": { sha256, contentLength } }`. */
function fakeS3(objects = {}) {
  const calls = [];
  return {
    calls,
    async head(bucket, key) {
      calls.push([bucket, key]);
      const object = objects[key];
      if (!object) return null;
      return { metadata: { sha256: object.sha256 }, contentLength: object.contentLength };
    },
  };
}

const PHOTO = (overrides) => ({
  slug: "dawn",
  published: true,
  masterSha256: SHA_A,
  ...overrides,
});

test("all present and matching is a pass", async () => {
  const s3 = fakeS3({
    "prints/dawn.jpg": { sha256: SHA_A, contentLength: 1234 },
    "prints/dusk.jpg": { sha256: SHA_B, contentLength: 99 },
  });
  const failures = await verifyMasters({
    photos: [PHOTO({ slug: "dawn" }), PHOTO({ slug: "dusk", masterSha256: SHA_B })],
    s3,
    allowlist: new Set(),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(s3.calls, [
    [MASTERS_BUCKET_NAME, "prints/dawn.jpg"],
    [MASTERS_BUCKET_NAME, "prints/dusk.jpg"],
  ]);
});

test("one missing is reported and the others are still checked", async () => {
  const s3 = fakeS3({
    "prints/dawn.jpg": { sha256: SHA_A, contentLength: 1234 },
    // dusk is absent
    "prints/noon.jpg": { sha256: SHA_A, contentLength: 5 },
  });
  const failures = await verifyMasters({
    photos: [
      PHOTO({ slug: "dawn" }),
      PHOTO({ slug: "dusk" }),
      PHOTO({ slug: "noon" }),
    ],
    s3,
    allowlist: new Set(),
  });
  assert.deepEqual(failures, [`dusk: missing from ${MASTERS_BUCKET_NAME}`]);
  // dawn and noon were checked too, not short-circuited by the failure.
  assert.equal(s3.calls.length, 3);
});

test("an unpublished photo is not checked", async () => {
  const s3 = fakeS3({});
  const failures = await verifyMasters({
    photos: [PHOTO({ slug: "draft", published: false, masterSha256: undefined })],
    s3,
    allowlist: new Set(),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(s3.calls, []);
});

test("a published photo without master_sha256 fails", async () => {
  const s3 = fakeS3({});
  const failures = await verifyMasters({
    photos: [PHOTO({ slug: "dawn", masterSha256: undefined })],
    s3,
    allowlist: new Set(),
  });
  assert.deepEqual(failures, ["dawn: no master_sha256 in the catalog"]);
  assert.deepEqual(s3.calls, []);
});

test("a hash mismatch, an empty object and a head failure are each reported", async () => {
  const s3 = fakeS3({
    "prints/dawn.jpg": { sha256: SHA_B, contentLength: 10 },
    "prints/dusk.jpg": { sha256: SHA_A, contentLength: 0 },
  });
  const failing = {
    head: async (_bucket, key) => {
      if (key === "prints/noon.jpg") throw new Error("boom");
      return s3.head(_bucket, key);
    },
  };
  const failures = await verifyMasters({
    photos: [
      PHOTO({ slug: "dawn" }),
      PHOTO({ slug: "dusk" }),
      PHOTO({ slug: "noon" }),
    ],
    s3: failing,
  });
  assert.equal(failures.length, 3);
  assert.match(failures[0]!, /dawn: sha256 mismatch \(catalog aaaaaaaa…, bucket bbbbbbbb…\)/);
  assert.match(failures[1]!, /dusk: empty object/);
  assert.match(failures[2]!, /noon: head failed: boom/);
});

test("metadataValue reads the sha256 key case-insensitively", () => {
  assert.equal(metadataValue({ sha256: "x" }, "sha256"), "x");
  assert.equal(metadataValue({ SHA256: "x" }, "sha256"), "x");
  assert.equal(metadataValue({}, "sha256"), undefined);
  assert.equal(metadataValue(undefined, "sha256"), undefined);
});

test("the read-only uploader refuses any bucket but the production masters bucket", async () => {
  const s3 = createMastersS3(ENV);
  await assert.rejects(
    () => s3.head("nessebar-lens-web", "dawn/abcd1234/400.jpg"),
    /refusing to read nessebar-lens-web/,
  );
  await assert.rejects(
    () => s3.head("nessebar-lens-masters-staging", "prints/dawn.jpg"),
    /refusing to read nessebar-lens-masters-staging/,
  );
});

test("photosToVerify keeps every published photo and drops the unpublished", () => {
  const photos = [
    { slug: "dawn", published: true, masterSha256: SHA_A },
    { slug: "draft", published: false, masterSha256: SHA_A },
    { slug: "cobblestones", published: true, masterSha256: SHA_A },
  ];
  assert.deepEqual(
    photosToVerify(photos).map((p) => p.slug),
    ["dawn", "cobblestones"],
  );
});

test("main is a no-op with an empty catalog", async () => {
  // No published photos means nothing to read, so the read-only token is not
  // required and the release is green.
  assert.deepEqual(photosToVerify([]).map((p) => p.slug), []);
  assert.equal(await main({}, []), 0);
});

test("main needs the read-only credentials as soon as a real photo must be checked", async () => {
  await assert.rejects(
    () => main({}, [{ slug: "real-photo", published: true, masterSha256: SHA_A }]),
    /missing env: R2_S3_ENDPOINT/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_MASTER_STATUS_CONTEXT,
  changedPhotoYamlFiles,
  finalStatusState,
  postPhotoMasterStatus,
  publishedPhotoFromYaml,
  readChangedPublishedPhotos,
  waitForPhotoMasters,
} from "../scripts/photo-master-attestation.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const MD5 = "c".repeat(32);

function photoYaml({ published = true }: { published?: boolean } = {}) {
  return `slug: dawn
title: Dawn
caption: Sunrise over the sea.
description: A quiet sunrise above the Black Sea.
alt: Sunrise over the Black Sea.
category: fine-art
published: ${published}
master_sha256: ${SHA_A}
image_hash: aaaaaaaa
master_width: 7714
master_height: 5146
orientation: landscape
print_asset_sha256: ${SHA_B}
print_asset_md5: ${MD5}
print_options:
  giclee: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75]
  framed: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75, 60x90]
  canvas: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75, 60x90, 70x100]
`;
}

test("changedPhotoYamlFiles selects changed catalog YAML, not deletions or other paths", () => {
  assert.deepEqual(
    changedPhotoYamlFiles([
      { filename: "content/photos/dawn.yaml", status: "added" },
      { filename: "content/photos/dusk.yml", status: "modified" },
      { filename: "content/photos/gone.yaml", status: "removed" },
      { filename: "content/orders/order.yaml", status: "modified" },
      { filename: "content/photos/nested/dawn.yaml", status: "added" },
    ]),
    ["content/photos/dawn.yaml", "content/photos/dusk.yml"],
  );
});

test("publishedPhotoFromYaml validates the entry and returns its production hashes", () => {
  assert.deepEqual(
    publishedPhotoFromYaml("content/photos/dawn.yaml", photoYaml()),
    {
      slug: "dawn",
      published: true,
      masterSha256: SHA_A,
      printAsset: { sha256: SHA_B, md5: MD5 },
    },
  );
});

test("unpublished catalog entries do not require production assets", () => {
  const draft = `slug: draft\ntitle: Draft\ncaption: Draft caption\ndescription: Draft description\nalt: Draft\ncategory: fine-art\npublished: false\n`;
  assert.equal(
    publishedPhotoFromYaml("content/photos/draft.yaml", draft),
    undefined,
  );
});

test("invalid photo catalog YAML fails closed", () => {
  assert.throws(
    () => publishedPhotoFromYaml("content/photos/dawn.yaml", "slug: other\n"),
    /must equal the filename/,
  );
});

test("PR catalog YAML is read through the API at the exact head SHA", async () => {
  const requests: string[] = [];
  const photos = await readChangedPublishedPhotos({
    repo: "owner/repo",
    number: 12,
    headSha: "d".repeat(40),
    token: "token",
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/pulls/12")) {
        return Response.json({ head: { sha: "d".repeat(40) } });
      }
      if (url.includes("/pulls/12/files?")) {
        return Response.json([
          { filename: "content/photos/dawn.yaml", status: "modified" },
          { filename: "content/photos/removed.yaml", status: "removed" },
          { filename: "README.md", status: "modified" },
        ]);
      }
      if (url.includes("/contents/content/photos/dawn.yaml?ref=")) {
        return Response.json({
          encoding: "base64",
          content: Buffer.from(photoYaml()).toString("base64"),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.deepEqual(photos, [
    {
      slug: "dawn",
      published: true,
      masterSha256: SHA_A,
      printAsset: { sha256: SHA_B, md5: MD5 },
    },
  ]);
  assert.equal(requests.length, 3);
  assert.ok(requests[2].includes(encodeURIComponent("d".repeat(40))));
});

test("a stale pull_request_target event cannot attest a newer PR head", async () => {
  let requestCount = 0;
  await assert.rejects(
    readChangedPublishedPhotos({
      repo: "owner/repo",
      number: 12,
      headSha: "d".repeat(40),
      token: "token",
      fetchImpl: async () => {
        requestCount += 1;
        return Response.json({ head: { sha: "e".repeat(40) } });
      },
    }),
    /changed while its photo assets were being checked/,
  );
  assert.equal(requestCount, 1, "do not read files from a mismatched head");
});

test("the required status passes only after changed published photos are verified", () => {
  assert.equal(
    finalStatusState({
      inspectResult: "success",
      hasPublishedPhotos: "true",
      verifyResult: "success",
    }),
    "success",
  );
  assert.equal(
    finalStatusState({
      inspectResult: "success",
      hasPublishedPhotos: "true",
      verifyResult: "failure",
    }),
    "failure",
  );
  assert.equal(
    finalStatusState({
      inspectResult: "success",
      hasPublishedPhotos: "false",
      verifyResult: "skipped",
    }),
    "success",
  );
  assert.equal(
    finalStatusState({
      inspectResult: "failure",
      hasPublishedPhotos: "false",
      verifyResult: "skipped",
    }),
    "failure",
  );
});

test("the production attestation waits for promotion, then checks both objects", async () => {
  let promoted = false;
  const keys: string[] = [];
  const s3 = {
    async head(_bucket: string, key: string) {
      keys.push(key);
      if (!promoted) return null;
      return {
        metadata: {
          sha256: key.startsWith("prints/") ? SHA_A : SHA_B,
        },
        contentLength: 12,
      };
    },
  };

  const result = await waitForPhotoMasters({
    photos: [
      {
        slug: "dawn",
        published: true,
        masterSha256: SHA_A,
        printAsset: { sha256: SHA_B, md5: MD5 },
      },
    ],
    s3,
    timeoutMs: 2,
    intervalMs: 1,
    now: (() => {
      let current = 0;
      return () => current++;
    })(),
    sleepImpl: async () => {
      promoted = true;
    },
  });

  assert.deepEqual(result, { ok: true, failures: [] });
  assert.deepEqual(keys, [
    "prints/dawn.jpg",
    "prints/dawn.jpg",
    "print-assets/dawn.jpg",
  ]);
});

test("the attestation posts the expected GitHub commit status context", async () => {
  let posted: { state: string; context: string } | undefined;
  await postPhotoMasterStatus("success", {
    repo: "owner/repo",
    sha: "d".repeat(40),
    token: "secret",
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    fetchImpl: async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(null, { status: 201 });
    },
  });
  assert.deepEqual(posted, {
    state: "success",
    context: PHOTO_MASTER_STATUS_CONTEXT,
    description: "Changed published photo assets match production masters.",
    target_url: "https://github.com/owner/repo/actions/runs/1",
  });
});

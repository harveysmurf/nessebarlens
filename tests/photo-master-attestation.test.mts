import assert from "node:assert/strict";
import test from "node:test";

import {
  changedPhotoYamlFiles,
  photoAssetChange,
  photoNeedsAssets,
  publishedPhotoFromYaml,
  readPhotosNeedingAssets,
  waitForPhotoMasters,
} from "../scripts/photo-master-attestation.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "d".repeat(64);
const MD5 = "c".repeat(32);
const HEAD_SHA = "d".repeat(40);
const BASE_SHA = "e".repeat(40);

function photoYaml({
  published = true,
  master = SHA_A,
  print = SHA_B,
  slug = "dawn",
  title = "Dawn",
}: {
  published?: boolean;
  master?: string;
  print?: string;
  slug?: string;
  title?: string;
} = {}) {
  return `slug: ${slug}
title: ${title}
caption: Sunrise over the sea.
description: A quiet sunrise above the Black Sea.
alt: Sunrise over the Black Sea.
category: fine-art
translations:
  bg:
    title: ${title}
    caption: Изгрев над морето.
    description: Спокоен изгрев над Черно море.
    alt: Изгрев над Черно море.
published: ${published}
master_sha256: ${master}
image_hash: aaaaaaaa
master_width: 7714
master_height: 5146
orientation: landscape
print_asset_sha256: ${print}
print_asset_md5: ${MD5}
print_options:
  giclee: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75]
  framed: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75, 60x90]
  canvas: [20x30, 30x40, 30x45, 40x60, 50x70, 50x75, 60x90, 70x100]
`;
}

/** What `publishedPhotoFromYaml` yields for a live listing. */
type PhotoEntry = {
  slug: string;
  published: boolean;
  masterSha256: string;
  printAsset: { sha256: string; md5: string };
};

const entry: PhotoEntry = {
  slug: "dawn",
  published: true,
  masterSha256: SHA_A,
  printAsset: { sha256: SHA_B, md5: MD5 },
};

test("changedPhotoYamlFiles selects changed catalog YAML, not deletions or other paths", () => {
  assert.deepEqual(
    changedPhotoYamlFiles([
      { filename: "content/photos/dawn.yaml", status: "added" },
      { filename: "content/photos/dusk.yml", status: "modified" },
      { filename: "content/photos/gone.yaml", status: "removed" },
      { filename: "content/orders/order.yaml", status: "modified" },
      { filename: "content/photos/nested/dawn.yaml", status: "added" },
    ]),
    [{ path: "content/photos/dawn.yaml" }, { path: "content/photos/dusk.yml" }],
  );
});

test("a catalog-to-catalog rename carries the base path it came from", () => {
  // Without `previousPath` a rename is indistinguishable from a new file, and
  // the base entry it *replaced* is never compared against — which would make
  // every rename wait for objects under the new slug, correctly, but would also
  // hide the case where the base path was never a listing at all.
  assert.deepEqual(
    changedPhotoYamlFiles([
      {
        filename: "content/photos/dusk.yaml",
        previous_filename: "content/photos/dawn.yaml",
        status: "renamed",
      },
    ]),
    [{ path: "content/photos/dusk.yaml", previousPath: "content/photos/dawn.yaml" }],
  );
});

test("a rename from outside the catalog directory has no previous catalog path", () => {
  assert.deepEqual(
    changedPhotoYamlFiles([
      {
        filename: "content/photos/dusk.yaml",
        previous_filename: "content/drafts/dusk.yaml",
        status: "renamed",
      },
    ]),
    [{ path: "content/photos/dusk.yaml" }],
  );
});

test("publishedPhotoFromYaml validates the entry and returns its production hashes", () => {
  assert.deepEqual(entry, {
    slug: "dawn",
    published: true,
    masterSha256: SHA_A,
    printAsset: { sha256: SHA_B, md5: MD5 },
  });
});

test("unpublished catalog entries do not require production assets", () => {
  const draft = `slug: draft\ntitle: Draft\ncaption: Draft caption\ndescription: Draft description\nalt: Draft\ncategory: fine-art\npublished: false\n`;
  assert.equal(publishedPhotoFromYaml("content/photos/draft.yaml", draft), undefined);
});

test("invalid photo catalog YAML fails closed", () => {
  assert.throws(
    () => publishedPhotoFromYaml("content/photos/dawn.yaml", "slug: other\n"),
    /must equal the filename/,
  );
});

test("photoNeedsAssets decides on the objects the bucket must hold, not on the diff", () => {
  // A retitled entry: the YAML differs, the extracted production objects do not.
  // `publishedPhotoFromYaml` reads only slug, published and the two hashes, which
  // is exactly why the decision can ignore a text-only edit.
  assert.deepEqual(
    publishedPhotoFromYaml("content/photos/dawn.yaml", photoYaml({ title: "Dawn at the water" })),
    entry,
  );
  const rehashedMaster = { ...entry, masterSha256: SHA_C };
  const rehashedPrintAsset = { ...entry, printAsset: { ...entry.printAsset, sha256: SHA_C } };

  const cases: [string, PhotoEntry | undefined, PhotoEntry | undefined, boolean][] = [
    // No base entry: a new listing, or one that was `published: false` at base.
    ["new file", undefined, entry, true],
    ["newly published", undefined, entry, true],
    ["rename", entry, { ...entry, slug: "dusk" }, true],
    ["master_sha256 changed", entry, rehashedMaster, true],
    ["print_asset_sha256 changed", entry, rehashedPrintAsset, true],
    ["title-only edit", entry, { ...entry }, false],
    ["identical entries", entry, { ...entry }, false],
    // Unpublished head: nothing is served for it, so nothing must exist.
    ["head unpublished", entry, undefined, false],
    ["both unpublished", undefined, undefined, false],
  ];

  for (const [name, base, head, expected] of cases) {
    assert.equal(photoNeedsAssets(base, head), expected, name);
  }
});

test("the reason a listing needs assets is the one the job log prints", () => {
  assert.deepEqual(photoAssetChange(undefined, entry), { needs: true, reason: "new listing" });
  assert.equal(photoAssetChange(entry, { ...entry, masterSha256: SHA_C })?.reason, "master changed");
  assert.equal(
    photoAssetChange(entry, { ...entry, printAsset: { ...entry.printAsset, sha256: SHA_C } })?.reason,
    "print asset changed",
  );
  // A rename is not visible in the two entries: the slug comes from the
  // filename, so it is passed in rather than inferred from a hash comparison.
  assert.equal(photoAssetChange(undefined, entry, { renamed: true })?.reason, "renamed");
  assert.equal(photoAssetChange(entry, { ...entry, slug: "dusk" })?.reason, "renamed");
  assert.equal(photoAssetChange(entry, entry), null);
});

/**
 * A fake GitHub API for the head/base reads: `contents` per `ref`, plus the PR
 * and its files list. Anything unlisted is a test bug and throws loudly rather
 * than silently returning nothing.
 */
function apiFetch({
  prHead = HEAD_SHA,
  files,
  head,
  base,
}: {
  prHead?: string;
  files: unknown[];
  head?: Record<string, string | undefined>;
  base?: Record<string, string | undefined>;
}) {
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/pulls/12")) return Response.json({ head: { sha: prHead } });
    if (url.includes("/pulls/12/files?")) return Response.json(files);
    const match = /\/contents\/(.*)\?ref=(.*)$/.exec(url);
    if (match) {
      const filePath = decodeURIComponent(match[1] ?? "");
      const ref = decodeURIComponent(match[2] ?? "");
      const yamlText = ref === HEAD_SHA ? head?.[filePath] : base?.[filePath];
      if (yamlText === undefined) return new Response(null, { status: 404 });
      return Response.json({
        encoding: "base64",
        content: Buffer.from(yamlText).toString("base64"),
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchImpl, requests };
}

test("PR catalog YAML is read through the API at the exact head and base SHAs", async () => {
  const { fetchImpl, requests } = apiFetch({
    files: [
      { filename: "content/photos/dawn.yaml", status: "modified" },
      { filename: "content/photos/removed.yaml", status: "removed" },
      { filename: "README.md", status: "modified" },
    ],
    head: { "content/photos/dawn.yaml": photoYaml() },
    base: { "content/photos/dawn.yaml": photoYaml() },
  });

  const needing = await readPhotosNeedingAssets({
    repo: "owner/repo",
    number: 12,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    token: "token",
    fetchImpl,
  });

  // Identical at both refs: the listing changed for some reason the catalog
  // cannot see, and the bucket is not re-read for it.
  assert.deepEqual(needing, []);
  assert.equal(requests.length, 4);
  assert.ok(requests.some((url) => url.includes(encodeURIComponent(HEAD_SHA))));
  assert.ok(requests.some((url) => url.includes(encodeURIComponent(BASE_SHA))));
});

test("a re-hashed listing is selected, and its base entry is read at baseSha", async () => {
  const { fetchImpl, requests } = apiFetch({
    files: [{ filename: "content/photos/dawn.yaml", status: "modified" }],
    head: { "content/photos/dawn.yaml": photoYaml({ master: SHA_C }) },
    base: { "content/photos/dawn.yaml": photoYaml() },
  });

  const needing = await readPhotosNeedingAssets({
    repo: "owner/repo",
    number: 12,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    token: "token",
    fetchImpl,
  });

  assert.deepEqual(needing, [{ photo: { ...entry, masterSha256: SHA_C }, reason: "master changed" }]);
  assert.ok(
    requests.some(
      (url) =>
        url.includes("content/photos/dawn.yaml") &&
        url.includes(encodeURIComponent(BASE_SHA)),
    ),
  );
});

test("a rename compares against the base path it came from", async () => {
  const { fetchImpl, requests } = apiFetch({
    files: [
      {
        filename: "content/photos/dusk.yaml",
        previous_filename: "content/photos/dawn.yaml",
        status: "renamed",
      },
    ],
    head: { "content/photos/dusk.yaml": photoYaml({ slug: "dusk", title: "Dusk" }) },
    // Same hashes at base: the *slug* moved, so the bucket keys did, and the
    // objects under the new slug have to be waited for.
    base: { "content/photos/dawn.yaml": photoYaml() },
  });

  const needing = await readPhotosNeedingAssets({
    repo: "owner/repo",
    number: 12,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    token: "token",
    fetchImpl,
  });

  assert.equal(needing.length, 1);
  assert.equal(needing[0]?.reason, "renamed");
  assert.ok(
    requests.some(
      (url) =>
        url.includes("content/photos/dawn.yaml") && url.includes(encodeURIComponent(BASE_SHA)),
    ),
    "the base entry is read from previous_filename, not from the new path",
  );
  assert.ok(
    !requests.some(
      (url) => url.includes("content/photos/dusk.yaml") && url.includes(encodeURIComponent(BASE_SHA)),
    ),
  );
});

test("a listing absent at base is treated as new, not as a failure", async () => {
  const { fetchImpl } = apiFetch({
    files: [{ filename: "content/photos/dawn.yaml", status: "added" }],
    head: { "content/photos/dawn.yaml": photoYaml() },
  });

  const needing = await readPhotosNeedingAssets({
    repo: "owner/repo",
    number: 12,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    token: "token",
    fetchImpl,
  });

  assert.deepEqual(needing, [{ photo: entry, reason: "new listing" }]);
});

test("an invalid base entry needs assets rather than erroring", async () => {
  // `main` should never hold invalid YAML, and if it somehow does this PR cannot
  // fix it. Failing closed would block a PR over a base-side problem; failing
  // open here would let a photo through unverified, which is the worse error.
  const { fetchImpl } = apiFetch({
    files: [{ filename: "content/photos/dawn.yaml", status: "modified" }],
    head: { "content/photos/dawn.yaml": photoYaml() },
    base: { "content/photos/dawn.yaml": "slug: other\n" },
  });

  const needing = await readPhotosNeedingAssets({
    repo: "owner/repo",
    number: 12,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    token: "token",
    fetchImpl,
  });

  assert.deepEqual(needing, [{ photo: entry, reason: "new listing" }]);
});

test("invalid head YAML still fails the job", async () => {
  const { fetchImpl } = apiFetch({
    files: [{ filename: "content/photos/dawn.yaml", status: "modified" }],
    head: { "content/photos/dawn.yaml": "slug: other\n" },
    base: { "content/photos/dawn.yaml": photoYaml() },
  });

  await assert.rejects(
    readPhotosNeedingAssets({
      repo: "owner/repo",
      number: 12,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      token: "token",
      fetchImpl,
    }),
    /must equal the filename/,
  );
});

test("a stale pull_request_target event cannot attest a newer PR head", async () => {
  let requestCount = 0;
  await assert.rejects(
    readPhotosNeedingAssets({
      repo: "owner/repo",
      number: 12,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      token: "token",
      fetchImpl: async () => {
        requestCount += 1;
        return Response.json({ head: { sha: "f".repeat(40) } });
      },
    }),
    /changed while its photo assets were being checked/,
  );
  assert.equal(requestCount, 1, "do not read files from a mismatched head");
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
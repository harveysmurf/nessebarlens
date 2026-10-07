/**
 * publish-photos --promote (#242): the PR checks, the local-master checksum
 * gate, the production-masters upload with its sha256 metadata, the read-back,
 * and the auto-merge — with S3 and gh injected as fakes.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  sha256Hex,
} from "../src/lib/derivative-ladder.ts";
import {
  createPromoteS3,
  metadataValue,
  planPromoteAction,
  repoFromPrUrl,
  runPromote,
  selectPromoteFiles,
  verifyPromotePr,
} from "../scripts/publish-photos.mjs";

const ENV = {
  R2_S3_ENDPOINT: "https://r2.example.com",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
};

const PR_URL = "https://github.com/harveysmurf/nessebarlens/pull/255";

function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "promote-"));
  mkdirSync(path.join(dir, "ingest"), { recursive: true });
  return dir;
}

async function writeMaster(file, { width = 3600, height = 2400, exif = true } = {}) {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 80, b: 160 } },
  });
  if (exif) pipeline = pipeline.withMetadata({ exif: { IFD0: { Make: "Fixture" } } });
  await pipeline.jpeg({ quality: 90 }).toFile(file);
}

function catalogYaml(slug, masterSha256) {
  return [
    "# owner note",
    "title: Dawn",
    "alt: Dawn over the bay",
    "caption: Medium Format",
    "description: First light over the bay.",
    "category: fine-art",
    `slug: ${slug}`,
    `master_sha256: ${masterSha256}`,
    `image_hash: ${masterSha256.slice(0, 8)}`,
    "",
  ].join("\n");
}

function pull(overrides = {}) {
  const number = overrides.number ?? 255;
  return {
    number,
    state: "OPEN",
    baseRefName: "main",
    headRefName: "photos/2026-10-06-dawn",
    author: { login: "harveysmurf" },
    url: `https://github.com/harveysmurf/nessebarlens/pull/${number}`,
    files: [{ path: "content/photos/dawn.yaml", changeType: "ADDED" }],
    ...overrides,
  };
}

async function manifest(dir, slugs) {
  const hashes = {};
  for (const slug of slugs) {
    const bytes = readFileSync(path.join(dir, `ingest/${slug}.jpg`));
    hashes[slug] = await sha256Hex(bytes);
  }
  return hashes;
}

/** An in-memory production-masters bucket seeded with {key: {metadata, contentLength}}. */
function fakePromoteS3(seed = {}, timeline = []) {
  const objects = new Map(Object.entries(seed));
  const calls = [];
  const puts = [];
  return {
    objects,
    calls,
    puts,
    async head(bucket, key) {
      calls.push(["head", bucket, key]);
      timeline.push(`head ${key}`);
      return objects.get(key) ?? null;
    },
    async put({ bucket, key, body, metadata, contentType, cacheControl }) {
      calls.push(["put", bucket, key]);
      timeline.push(`put ${key}`);
      const record = { metadata, contentLength: body.length, contentType, cacheControl };
      objects.set(key, record);
      puts.push(record);
    },
  };
}

function fakeGh(
  {
    pull: pullJson = pull(),
    user = "harveysmurf",
    userStatus = 0,
    yamlByPath = {},
    baseYamlByPath = {},
    mergeStatus = 0,
  } = {},
  timeline = [],
) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command !== "gh") return { status: 1, stdout: "", stderr: "not gh" };
    if (args[0] === "pr" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify(pullJson), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "user") {
      return userStatus === 0
        ? { status: 0, stdout: `${user}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "not logged in" };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      const endpoint = args[1];
      const file = decodeURIComponent(
        endpoint.replace(/^repos\/[^/]+\/[^/]+\/contents\//, "").replace(/\?.*$/, ""),
      );
      const refMatch = /[?&]ref=([^&]+)/.exec(endpoint);
      const ref = refMatch ? decodeURIComponent(refMatch[1]) : "";
      const source = ref === (pullJson.baseRefName ?? "main") ? baseYamlByPath : yamlByPath;
      const text = source[file];
      if (text === undefined) return { status: 1, stdout: "", stderr: `404 ${file}@${ref}` };
      return { status: 0, stdout: text, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      timeline.push(`merge ${args[2]}`);
      return {
        status: mergeStatus,
        stdout: "",
        stderr: mergeStatus === 0 ? "" : "merge failed",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

function deps(overrides = {}) {
  const logs = [];
  return {
    logs,
    s3: overrides.s3 ?? fakePromoteS3(),
    exec: overrides.exec ?? fakeGh(),
    env: ENV,
    log: (line) => logs.push(line),
  };
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

test("selectPromoteFiles keeps content/photos YAML, allows placeholders, flags the rest", () => {
  const { outside, yamls } = selectPromoteFiles([
    { path: "content/photos/dawn.yaml", changeType: "ADDED" },
    { path: "content/photos/dusk.yml", changeType: "MODIFIED" },
    { path: "content/photos/README.md", changeType: "ADDED" },
    { path: "public/placeholders/dawn.jpg", changeType: "ADDED" },
    { path: "src/lib/foo.ts", changeType: "MODIFIED" },
  ]);
  assert.deepEqual(
    yamls,
    [
      { path: "content/photos/dawn.yaml", slug: "dawn", changeType: "ADDED" },
      { path: "content/photos/dusk.yml", slug: "dusk", changeType: "MODIFIED" },
    ],
  );
  // The committed fallback placeholder is part of a publish PR (#257).
  assert.deepEqual(outside, ["src/lib/foo.ts"]);
});

test("selectPromoteFiles refuses deleted or non-JPEG placeholder files", () => {
  const { outside } = selectPromoteFiles([
    { path: "content/photos/dawn.yaml", changeType: "ADDED" },
    { path: "public/placeholders/dawn.svg", changeType: "ADDED" },
    { path: "public/placeholders/gone.jpg", changeType: "DELETED" },
  ]);
  assert.deepEqual(outside, [
    "public/placeholders/dawn.svg",
    "public/placeholders/gone.jpg",
  ]);
});

test("verifyPromotePr refuses closed, mis-based, non-owner and out-of-scope PRs", () => {
  assert.deepEqual(verifyPromotePr(pull(), "harveysmurf").errors, []);

  const closed = verifyPromotePr(pull({ state: "MERGED" }), "harveysmurf");
  assert.match(closed.errors.join("\n"), /not open/);

  const wrongBase = verifyPromotePr(pull({ baseRefName: "develop" }), "harveysmurf");
  assert.match(wrongBase.errors.join("\n"), /not main/);

  const notOwner = verifyPromotePr(pull({ author: { login: "someone-else" } }), "harveysmurf");
  assert.match(notOwner.errors.join("\n"), /not the owner/);

  const outside = verifyPromotePr(
    pull({ files: [{ path: "src/lib/foo.ts", changeType: "MODIFIED" }] }),
    "harveysmurf",
  );
  assert.match(outside.errors.join("\n"), /outside content\/photos\//);

  const deleted = verifyPromotePr(
    pull({ files: [{ path: "content/photos/dawn.yaml", changeType: "DELETED" }] }),
    "harveysmurf",
  );
  assert.match(deleted.errors.join("\n"), /deletes content\/photos\/dawn\.yaml/);

  const none = verifyPromotePr(
    pull({ files: [{ path: "content/photos/README.md", changeType: "ADDED" }] }),
    "harveysmurf",
  );
  assert.match(none.errors.join("\n"), /changes no/);
});

test("planPromoteAction uploads, skips, replaces or refuses", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(planPromoteAction({ existing: null, masterSha256: sha, isReplace: false }), {
    action: "upload",
  });
  assert.deepEqual(
    planPromoteAction({ existing: { metadata: { sha256: sha } }, masterSha256: sha, isReplace: false }),
    { action: "skip" },
  );
  assert.deepEqual(
    planPromoteAction({ existing: { metadata: { SHA256: sha } }, masterSha256: sha, isReplace: false }),
    { action: "skip" },
  );
  const refused = planPromoteAction({
    existing: { metadata: { sha256: "b".repeat(64) } },
    masterSha256: sha,
    isReplace: false,
  });
  assert.equal(refused.action, "refuse");
  assert.match(refused.reason, /--replace-image/);
  assert.deepEqual(
    planPromoteAction({
      existing: { metadata: { sha256: "b".repeat(64) } },
      masterSha256: sha,
      isReplace: true,
    }),
    { action: "replace" },
  );
  assert.equal(metadataValue({ SHA256: "x" }, "sha256"), "x");
  assert.equal(metadataValue(undefined, "sha256"), undefined);
});

test("repoFromPrUrl reads owner/repo and rejects a non-GitHub URL", () => {
  assert.deepEqual(repoFromPrUrl(PR_URL), { owner: "harveysmurf", repo: "nessebarlens" });
  assert.equal(repoFromPrUrl("https://example.com/x"), null);
  assert.equal(repoFromPrUrl(undefined), null);
});

// ---------------------------------------------------------------------------
// runPromote with fakes
// ---------------------------------------------------------------------------

test("a happy promote puts the master with sha256 metadata, reads it back, then merges", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const bytes = readFileSync(path.join(dir, "ingest/dawn.jpg"));
    const sha = await sha256Hex(bytes);
    const timeline = [];
    const s3 = fakePromoteS3({}, timeline);
    const exec = fakeGh(
      { pull: pull(), yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) } },
      timeline,
    );
    const d = deps({ s3, exec });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, d);

    assert.equal(result.status, 0);
    const stored = s3.objects.get("prints/dawn.jpg");
    assert.equal(stored!.metadata!.sha256, sha);
    assert.equal(stored!.contentLength, bytes.length);
    // The promoted object is the unmodified JPEG with the headers the spec asks for.
    assert.equal(stored!.contentType, "image/jpeg");
    assert.equal(stored!.cacheControl, "private, no-store");
    assert.deepEqual(s3.puts.map((p) => p.contentType), ["image/jpeg"]);
    // Every bucket touched is the production masters bucket.
    assert.ok(
      s3.calls.every((call) => call[1] === MASTERS_BUCKET_NAME),
      "only nessebar-lens-masters is touched",
    );
    // The catalog is read from the PR head, not from main.
    assert.ok(
      exec.calls.some(
        (c) => typeof c[2] === "string" && c[2].includes("content/photos/dawn.yaml") &&
          c[2].includes(`ref=${encodeURIComponent("photos/2026-10-06-dawn")}`),
      ),
      "reads the YAML at the PR head ref",
    );

    const putAt = timeline.indexOf("put prints/dawn.jpg");
    const readAt = timeline.indexOf("head prints/dawn.jpg", putAt + 1);
    const mergeAt = timeline.indexOf("merge 255");
    assert.ok(putAt >= 0, "PutObject ran");
    assert.ok(readAt > putAt, "HeadObject read-back ran after the put");
    assert.ok(mergeAt > readAt, "gh pr merge ran after the read-back");
    assert.ok(
      exec.calls.some((c) => c.join(" ") === "gh pr merge 255 --auto --squash"),
      "auto-merge is squash",
    );
    assert.equal(d.logs.some((line) => line.includes("auto-merge")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checksum mismatch refuses with zero uploads even when other photos match", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    await writeMaster(path.join(dir, "ingest/dusk.jpg"));
    const hashes = await manifest(dir, ["dawn", "dusk"]);
    const s3 = fakePromoteS3();
    const exec = fakeGh({
      pull: pull({
        files: [
          { path: "content/photos/dawn.yaml", changeType: "ADDED" },
          { path: "content/photos/dusk.yaml", changeType: "ADDED" },
        ],
      }),
      yamlByPath: {
        "content/photos/dawn.yaml": catalogYaml("dawn", hashes.dawn!),
        // The previewed hash for dusk is not what is in ingest/ now.
        "content/photos/dusk.yaml": catalogYaml("dusk", "f".repeat(64)),
      },
    });
    const d = deps({ s3, exec });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, d);

    assert.equal(result.status, 1);
    assert.equal(s3.calls.filter((c) => c[0] === "put").length, 0);
    assert.equal(s3.calls.length, 0, "no bucket is even read before the checks pass");
    assert.match(result.fatals!.join("\n"), /ingest\/dusk\.jpg is not the file that was previewed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing local master is refused before any upload", async () => {
  const dir = makeProject();
  try {
    const s3 = fakePromoteS3();
    const exec = fakeGh({
      pull: pull(),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", "a".repeat(64)) },
    });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, deps({ s3, exec }));
    assert.equal(result.status, 1);
    assert.equal(s3.calls.length, 0);
    assert.match(result.fatals!.join("\n"), /missing ingest\/dawn\.jpg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PR touching files outside content/photos and placeholders is refused", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const sha = (await manifest(dir, ["dawn"])).dawn!;
    const s3 = fakePromoteS3();
    const exec = fakeGh({
      pull: pull({
        files: [
          { path: "content/photos/dawn.yaml", changeType: "ADDED" },
          { path: "public/placeholders/dawn.jpg", changeType: "ADDED" },
          { path: "src/lib/foo.ts", changeType: "MODIFIED" },
        ],
      }),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
    });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, deps({ s3, exec }));
    assert.equal(result.status, 1);
    assert.equal(s3.calls.length, 0);
    assert.match(result.fatals!.join("\n"), /outside content\/photos\/ and public\/placeholders\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PR carrying the committed placeholder is promoted normally", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const sha = (await manifest(dir, ["dawn"])).dawn!;
    const s3 = fakePromoteS3();
    const exec = fakeGh({
      pull: pull({
        files: [
          { path: "content/photos/dawn.yaml", changeType: "ADDED" },
          { path: "public/placeholders/dawn.jpg", changeType: "ADDED" },
        ],
      }),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
    });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, deps({ s3, exec }));
    assert.equal(result.status, 0);
    assert.equal(s3.objects.get("prints/dawn.jpg")!.metadata!.sha256, sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-back mismatch does not enable auto-merge", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const sha = (await manifest(dir, ["dawn"])).dawn!;
    const objects = new Map<string, { metadata: Record<string, string>; contentLength: number }>();
    const calls: unknown[][] = [];
    const s3 = {
      objects,
      calls,
      async head(bucket: string, key: string) {
        calls.push(["head", bucket, key]);
        return objects.get(key) ?? null;
      },
      async put({ key, body }: { key: string; body: Buffer }) {
        calls.push(["put", key]);
        // The stored metadata is wrong, so the read-back must catch it.
        objects.set(key, { metadata: { sha256: "0".repeat(64) }, contentLength: body.length });
      },
    };
    const exec = fakeGh({
      pull: pull(),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
    });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, deps({ s3, exec }));
    assert.equal(result.status, 1);
    assert.match(result.fatals!.join("\n"), /read-back/);
    assert.equal(
      exec.calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge"),
      false,
      "auto-merge is not enabled on a read-back mismatch",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed gh api user refuses and does not guess the owner", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const sha = (await manifest(dir, ["dawn"])).dawn!;
    const s3 = fakePromoteS3();
    const exec = fakeGh({
      userStatus: 1,
      pull: pull(),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
    });
    const result = await runPromote({ cwd: dir, promote: true, pr: 255 }, deps({ s3, exec }));
    assert.equal(result.status, 1);
    assert.match(result.fatals!.join("\n"), /could not determine the authenticated user/);
    assert.equal(s3.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing same-hash master is skipped, and a different one without a replacement is refused", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    const bytes = readFileSync(path.join(dir, "ingest/dawn.jpg"));
    const sha = await sha256Hex(bytes);

    // Same hash: skip, no put, still auto-merge.
    const same = fakePromoteS3({
      "prints/dawn.jpg": { metadata: { sha256: sha }, contentLength: bytes.length },
    });
    const sameExec = fakeGh({
      pull: pull(),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
    });
    const sameResult = await runPromote(
      { cwd: dir, promote: true, pr: 255 },
      deps({ s3: same, exec: sameExec }),
    );
    assert.equal(sameResult.status, 0);
    assert.equal(same.calls.filter((c) => c[0] === "put").length, 0, "no overwrite");
    assert.ok(sameExec.calls.some((c) => c.join(" ") === "gh pr merge 255 --auto --squash"));

    // Different hash, no replacement: refuse.
    const different = fakePromoteS3({
      "prints/dawn.jpg": { metadata: { sha256: "b".repeat(64) }, contentLength: 1 },
    });
    const refused = await runPromote(
      { cwd: dir, promote: true, pr: 255 },
      deps({
        s3: different,
        exec: fakeGh({
          pull: pull(),
          yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
        }),
      }),
    );
    assert.equal(refused.status, 1);
    assert.equal(different.calls.filter((c) => c[0] === "put").length, 0);
    assert.match(refused.fatals!.join("\n"), /--replace-image/);

    // A modified catalog entry whose base hash differs (a real --replace-image)
    // overwrites and warns.
    const replace = fakePromoteS3({
      "prints/dawn.jpg": { metadata: { sha256: "b".repeat(64) }, contentLength: 1 },
    });
    const replaceExec = fakeGh({
      pull: pull({ files: [{ path: "content/photos/dawn.yaml", changeType: "MODIFIED" }] }),
      yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
      baseYamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", "b".repeat(64)) },
    });
    const replaceDeps = deps({ s3: replace, exec: replaceExec });
    const replaceResult = await runPromote({ cwd: dir, promote: true, pr: 255 }, replaceDeps);
    assert.equal(replaceResult.status, 0);
    assert.equal(replace.calls.filter((c) => c[0] === "put").length, 1);
    assert.equal(replace.objects.get("prints/dawn.jpg")!.metadata!.sha256, sha);
    assert.equal(replaceDeps.logs.some((line) => line.includes("past buyers")), true);

    // A caption-only edit (base hash equals the head hash) is NOT a
    // replacement: a production master with a different hash is still refused.
    const caption = fakePromoteS3({
      "prints/dawn.jpg": { metadata: { sha256: "b".repeat(64) }, contentLength: 1 },
    });
    const captionResult = await runPromote(
      { cwd: dir, promote: true, pr: 255 },
      deps({
        s3: caption,
        exec: fakeGh({
          pull: pull({ files: [{ path: "content/photos/dawn.yaml", changeType: "MODIFIED" }] }),
          yamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
          baseYamlByPath: { "content/photos/dawn.yaml": catalogYaml("dawn", sha) },
        }),
      }),
    );
    assert.equal(captionResult.status, 1);
    assert.equal(caption.calls.filter((c) => c[0] === "put").length, 0);
    assert.match(captionResult.fatals!.join("\n"), /--replace-image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--promote needs a numeric --pr", async () => {
  const result = await runPromote({ promote: true }, deps());
  assert.equal(result.status, 1);
  assert.match(result.fatals!.join("\n"), /--pr <n>/);
});

test("the promote uploader refuses the web and staging buckets", async () => {
  const s3 = createPromoteS3(ENV);
  await assert.rejects(
    () =>
      s3.put({
        bucket: WEB_BUCKET_NAME,
        key: "dawn/abcd1234/400.jpg",
        body: Buffer.from("x"),
        contentType: "image/jpeg",
        cacheControl: "x",
        metadata: {},
      }),
    /refusing to write nessebar-lens-web/,
  );
  await assert.rejects(
    () => s3.head(STAGING_MASTERS_BUCKET_NAME, "prints/dawn.jpg"),
    /refusing to write nessebar-lens-masters-staging/,
  );
  // The production masters bucket is the one it does allow.
  assert.equal(typeof MASTERS_BUCKET_NAME, "string");
});

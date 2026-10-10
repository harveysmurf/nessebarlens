/**
 * publish-photos: the pairing/validation decisions, the upload plan, the YAML
 * write, and the git/PR flow with S3 and git/gh injected as fakes.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";

import { buildCatalog } from "../scripts/build-catalog.mjs";
import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_WIDTHS,
  sha256Hex,
} from "../src/domain/catalog/derivative-ladder.ts";
import {
  branchName,
  createReadMastersS3,
  createS3,
  pairInputs,
  parseArgs,
  patchCatalogFactsYaml,
  planWebObjects,
  prBody,
  readCatalogForSync,
  renderCatalogYaml,
  resolutionFindings,
  runPublish,
  syncCatalogFacts,
  syncDecision,
  validatePhoto,
} from "../scripts/publish-photos.mjs";

const OWNER_YAML = [
  "# owner note",
  "title: Dawn",
  "alt: Dawn over the bay",
  "caption: Medium Format",
  "description: First light over the bay.",
  "category: fine-art",
  "",
].join("\n");

const ENV = {
  R2_S3_ENDPOINT: "https://r2.example.com",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
};

function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "publish-"));
  mkdirSync(path.join(dir, "content/photos"), { recursive: true });
  mkdirSync(path.join(dir, "ingest"), { recursive: true });
  return dir;
}

async function writeMaster(
  file,
  { width = 3600, height = 2400, exif = false, orientation } = {},
) {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 64, b: 32 } },
  });
  if (exif) pipeline = pipeline.withMetadata({ exif: { IFD0: { Make: "Fixture" } } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await pipeline.jpeg({ quality: 90 }).toFile(file);
}

function fakeS3() {
  const puts = [];
  return {
    puts,
    async exists() {
      return false;
    },
    async put(object) {
      puts.push(object);
    },
  };
}

// The #297 read-only masters client. By default every master is absent, so the
// automatic sync warns "unpromoted" and continues; a test that needs a decision
// (measure / mismatch / in-sync) passes its own head/getObject.
function fakeSyncS3({ head = null, getObject } = {}) {
  return {
    head: typeof head === "function" ? head : async () => head,
    getObject:
      getObject ??
      (async () => {
        throw new Error("fakeSyncS3.getObject was not expected");
      }),
  };
}

function fakeExec({ dirty = [], prUrl = "https://github.com/harveysmurf/nessebarlens/pull/999" } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "status") {
      return {
        status: 0,
        stdout: dirty.map((file) => ` M ${file}`).join("\n"),
        stderr: "",
      };
    }
    if (command === "gh") return { status: 0, stdout: `${prUrl}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

function deps(overrides = {}) {
  const logs = [];
  return {
    logs,
    s3: overrides.s3 ?? fakeS3(),
    syncS3: overrides.syncS3 ?? fakeSyncS3(),
    exec: overrides.exec ?? fakeExec(),
    env: ENV,
    now: () => new Date("2026-10-06T12:00:00Z"),
    log: (line) => logs.push(line),
  };
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

test("parseArgs reads the flags", () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    promote: false,
    audit: false,
    json: false,
    pr: undefined,
    only: undefined,
    replaceImage: undefined,
    dir: undefined,
  });
  assert.deepEqual(parseArgs(["--apply", "--only", "dawn, dusk", "--replace-image", "dawn", "--dir", "drop"]), {
    apply: true,
    promote: false,
    audit: false,
    json: false,
    pr: undefined,
    only: ["dawn", "dusk"],
    replaceImage: "dawn",
    dir: "drop",
  });
  assert.deepEqual(parseArgs(["--promote", "--pr", "242", "--dir", "drop"]), {
    apply: false,
    promote: true,
    audit: false,
    json: false,
    pr: 242,
    only: undefined,
    replaceImage: undefined,
    dir: "drop",
  });
  assert.deepEqual(parseArgs(["--audit", "--json"]), {
    apply: false,
    promote: false,
    audit: true,
    json: true,
    pr: undefined,
    only: undefined,
    replaceImage: undefined,
    dir: undefined,
  });
  // A missing or non-numeric --pr is left undefined rather than treated as 0.
  assert.equal(parseArgs(["--promote"]).pr, undefined);
  assert.equal(parseArgs(["--promote", "--pr", "nope"]).pr, undefined);
});

test("pairInputs matches a jpg with its yaml and reports a missing half", () => {
  const { pairs, problems, ignored } = pairInputs([
    "dawn.jpg",
    "dawn.yaml",
    "dusk.jpg",
    "notes.txt",
    "night.yml",
  ]);
  assert.deepEqual(pairs, [{ slug: "dawn", jpeg: "dawn.jpg", yaml: "dawn.yaml" }]);
  assert.deepEqual(problems, [
    "dusk: has dusk.jpg but no dusk.yaml",
    "night: has night.yml but no night.jpg",
  ]);
  assert.deepEqual(ignored, ["notes.txt"]);
});

test("resolutionFindings refuses 3499, warns at 3500, is clean at 6000", () => {
  assert.match(resolutionFindings(3499).errors[0]!, /below the 3500px minimum/);
  assert.deepEqual(resolutionFindings(3500).errors, []);
  assert.match(resolutionFindings(3500).warnings[0]!, /~89 dpi/);
  assert.deepEqual(resolutionFindings(6000).warnings, []);
});

test("validatePhoto checks the schema, the generated keys, and the hash rules", () => {
  const base = {
    slug: "dawn",
    yamlText: OWNER_YAML,
    longEdge: 4000,
    existing: null,
    newSha256: "a".repeat(64),
    replaceImage: undefined,
  };
  assert.deepEqual(validatePhoto(base).errors, []);

  const withGenerated = validatePhoto({
    ...base,
    yamlText: OWNER_YAML + "master_sha256: " + "a".repeat(64) + "\n",
  });
  assert.match(withGenerated.errors.join("\n"), /master_sha256 must be absent/);

  const badSchema = validatePhoto({ ...base, yamlText: "title: ''\ncategory: fine-art\n" });
  assert.match(badSchema.errors.join("\n"), /dawn\.yaml: title:/);

  const existing = validatePhoto({
    ...base,
    existing: { masterSha256: "b".repeat(64) },
  });
  assert.match(existing.errors.join("\n"), /pass --replace-image dawn/);

  const replaceSame = validatePhoto({
    ...base,
    existing: { masterSha256: "a".repeat(64) },
    replaceImage: "dawn",
  });
  assert.match(replaceSame.errors.join("\n"), /identical/);

  const replaceNew = validatePhoto({
    ...base,
    existing: { masterSha256: "b".repeat(64) },
    replaceImage: "dawn",
  });
  assert.deepEqual(replaceNew.errors, []);
});

test("planWebObjects is four widths × two formats under {slug}/{hash}", () => {
  const objects = planWebObjects("dawn", "abcd1234");
  assert.equal(objects.length, WEB_DERIVATIVE_WIDTHS.length * 2);
  assert.ok(objects.every((o) => o.key.startsWith("dawn/abcd1234/")));
  assert.deepEqual(
    [...new Set(objects.map((o) => o.width))].sort((a, b) => a - b),
    [400, 750, 1500, 2000],
  );
  assert.equal(objects.find((o) => o.format === "webp")!.contentType, "image/webp");
  assert.equal(objects.find((o) => o.format === "jpg")!.contentType, "image/jpeg");
});

const FACTS = { width: 4901, height: 3351, orientation: "landscape" };

test("renderCatalogYaml keeps the owner's comment and appends the generated keys", () => {
  const out = renderCatalogYaml(OWNER_YAML, {
    slug: "dawn",
    masterSha256: "a".repeat(64),
    imageHash: "abcd1234",
    masterFacts: FACTS,
  });
  assert.match(out, /# owner note/);
  assert.match(out, /title: Dawn/);
  assert.match(out, /slug: dawn/);
  assert.match(out, new RegExp(`master_sha256: ${"a".repeat(64)}`));
  assert.match(out, /image_hash: abcd1234/);
  assert.match(out, /master_width: 4901/);
  assert.match(out, /master_height: 3351/);
  assert.match(out, /orientation: landscape/);
  assert.match(out, /# written by publish-photos/);
  // The generated keys are last, in the order publish-photos writes them.
  assert.ok(out.indexOf("image_hash") > out.indexOf("category:"));
  const order = ["master_sha256", "image_hash", "master_width", "master_height", "orientation"];
  const indices = order.map((key) => out.indexOf(`${key}:`));
  assert.deepEqual([...indices].sort((a, b) => a - b), indices);
});

test("renderCatalogYaml does not duplicate an owner slug", () => {
  const out = renderCatalogYaml("title: Dawn\nslug: dawn\n", {
    slug: "dawn",
    masterSha256: "a".repeat(64),
    imageHash: "abcd1234",
    masterFacts: FACTS,
  });
  assert.equal(out.match(/^slug:/gm)?.length, 1);
});

test("branchName and prBody are the specified shapes", () => {
  assert.equal(branchName("2026-10-06", ["dawn"]), "photos/2026-10-06-dawn");
  assert.equal(
    branchName("2026-10-06", ["dawn", "dusk", "noon"]),
    "photos/2026-10-06-dawn-and-2-more",
  );
  const body = prBody(
    [{ slug: "dawn", title: "Dawn", category: "fine-art", longEdge: 4000, warnings: [] }],
    "2026-10-06",
  );
  assert.match(body, /\| dawn \| Dawn \| fine-art \| 4000px \|/);
  assert.match(body, /staging masters \(2500 px\)/);
  assert.match(body, /--promote --pr/);
});

// ---------------------------------------------------------------------------
// runPublish with fakes
// ---------------------------------------------------------------------------

test("a dry run prints the plan and uploads nothing", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    const d = deps();
    const result = await runPublish({ cwd: dir, apply: false }, d);
    assert.equal(result.status, 0);
    assert.equal(d.s3.puts.length, 0);
    assert.ok(d.logs.some((line) => line.includes("staging master")));
    assert.ok(d.logs.some((line) => line.includes("image_hash")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one bad photo in a batch of three uploads nothing and reports every error", async () => {
  const dir = makeProject();
  try {
    for (const slug of ["dawn", "dusk", "noon"]) {
      await writeMaster(path.join(dir, `ingest/${slug}.jpg`), { width: 3600, height: 2400 });
      writeFileSync(path.join(dir, `ingest/${slug}.yaml`), OWNER_YAML);
    }
    // Break two: an empty title and a bad category.
    writeFileSync(path.join(dir, "ingest/dusk.yaml"), OWNER_YAML.replace("title: Dawn", "title: ''"));
    writeFileSync(path.join(dir, "ingest/noon.yaml"), OWNER_YAML.replace("category: fine-art", "category: panorama"));
    const d = deps();
    const result = await runPublish({ cwd: dir, apply: true }, d);
    assert.equal(result.status, 1);
    assert.equal(d.s3.puts.length, 0);
    assert.match(result.fatals.join("\n"), /dusk\.yaml: title:/);
    assert.match(result.fatals.join("\n"), /noon\.yaml: category:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--apply uploads 8 web objects + 1 staging master and never production masters", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"), { exif: true });
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    const d = deps();
    const result = await runPublish({ cwd: dir, apply: true }, d);
    assert.equal(result.status, 0);
    const web = d.s3.puts.filter((p) => p.bucket === WEB_BUCKET_NAME);
    const staging = d.s3.puts.filter((p) => p.bucket === STAGING_MASTERS_BUCKET_NAME);
    assert.equal(web.length, 8);
    assert.equal(staging.length, 1);
    assert.equal(d.s3.puts.some((p) => p.bucket === MASTERS_BUCKET_NAME), false);
    assert.equal(staging[0]!.key, "prints/dawn.jpg");

    // The staging master is a <=2500px, EXIF-stripped, aspect-preserving JPEG.
    const meta = await sharp(staging[0]!.body).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 2500);
    assert.ok(Math.abs((meta.height ?? 0) - (2500 * 2400) / 3600) <= 1, `height ${meta.height}`);
    assert.equal(meta.exif, undefined, "staging master must have no EXIF");

    // The written YAML gains the generated keys and keeps the owner's comment.
    const written = readFileSync(path.join(dir, "content/photos/dawn.yaml"), "utf8");
    assert.match(written, /# owner note/);
    assert.match(written, /slug: dawn/);
    assert.match(written, /master_sha256: [0-9a-f]{64}/);
    assert.match(written, /image_hash: [0-9a-f]{8}/);
    assert.match(written, /master_width: 3600/);
    assert.match(written, /master_height: 2400/);
    assert.match(written, /orientation: landscape/);
    assert.match(written, /# written by publish-photos/);

    // No committed placeholder is written anymore (#245).
    assert.equal(existsSync(path.join(dir, "public/placeholders")), false);

    // Git: branch from origin/main, add content/photos, one commit.
    assert.ok(d.exec.calls.some((c) => c[0] === "git" && c[1] === "checkout" && c.includes(result.branch)));
    assert.ok(d.exec.calls.some((c) => c.join(" ") === "git add -- content/photos"));
    assert.ok(d.exec.calls.some((c) => c[0] === "gh" && c[1] === "pr"));
    assert.equal(result.branch, "photos/2026-10-06-dawn");
    assert.equal(result.prUrl, "https://github.com/harveysmurf/nessebarlens/pull/999");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish records master facts for landscape, rotated portrait and square (#295)", async () => {
  const dir = makeProject();
  try {
    // Landscape, as stored and seen.
    await writeMaster(path.join(dir, "ingest/landscape.jpg"), {
      width: 3600,
      height: 2400,
    });
    writeFileSync(path.join(dir, "ingest/landscape.yaml"), OWNER_YAML);

    // EXIF orientation 6: stored landscape, seen as a 2400x3600 portrait.
    await writeMaster(path.join(dir, "ingest/portrait.jpg"), {
      width: 3600,
      height: 2400,
      orientation: 6,
    });
    writeFileSync(path.join(dir, "ingest/portrait.yaml"), OWNER_YAML);

    await writeMaster(path.join(dir, "ingest/square.jpg"), {
      width: 3600,
      height: 3600,
    });
    writeFileSync(path.join(dir, "ingest/square.yaml"), OWNER_YAML);

    const result = await runPublish({ cwd: dir, apply: true }, deps());
    assert.equal(result.status, 0, result.fatals?.join("\n"));

    const readYaml = (slug: string) =>
      parseYaml(
        readFileSync(path.join(dir, "content/photos", `${slug}.yaml`), "utf8"),
      );
    const landscape = readYaml("landscape") as Record<string, unknown>;
    assert.equal(landscape.master_width, 3600);
    assert.equal(landscape.master_height, 2400);
    assert.equal(landscape.orientation, "landscape");

    const portrait = readYaml("portrait") as Record<string, unknown>;
    assert.equal(portrait.master_width, 2400, "EXIF 6 swaps the stored axes");
    assert.equal(portrait.master_height, 3600);
    assert.equal(portrait.orientation, "portrait");

    const square = readYaml("square") as Record<string, unknown>;
    assert.equal(square.master_width, 3600);
    assert.equal(square.master_height, 3600);
    assert.equal(square.orientation, "square");

    // Key order is the order publish-photos writes, and the one comment marks
    // the generated block.
    const raw = readFileSync(
      path.join(dir, "content/photos/landscape.yaml"),
      "utf8",
    );
    const order = ["master_sha256", "image_hash", "master_width", "master_height", "orientation"];
    const indices = order.map((key) => raw.indexOf(`${key}:`));
    assert.ok(indices.every((i) => i >= 0), raw);
    assert.deepEqual([...indices].sort((a, b) => a - b), indices);
    assert.match(raw, /# written by publish-photos/);

    // build-catalog compiles the facts into the catalog entry.
    const build = buildCatalog({
      photosDir: path.join(dir, "content/photos"),
      outFile: path.join(dir, "generated.ts"),
    });
    assert.equal(build.ok, true, build.problems.join("\n"));
    const built = build.photos.find((photo) => photo.slug === "portrait");
    assert.deepEqual(built?.master, {
      width: 2400,
      height: 3600,
      orientation: "portrait",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--replace-image rewrites the master facts with the new size (#295)", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"), {
      width: 3600,
      height: 2400,
    });
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    assert.equal((await runPublish({ cwd: dir, apply: true }, deps())).status, 0);

    // Replace with a portrait master: all five generated keys change together.
    await writeMaster(path.join(dir, "ingest/dawn.jpg"), {
      width: 2400,
      height: 3600,
    });
    const result = await runPublish(
      { cwd: dir, apply: true, replaceImage: "dawn" },
      deps(),
    );
    assert.equal(result.status, 0, result.fatals?.join("\n"));

    const dawn = parseYaml(
      readFileSync(path.join(dir, "content/photos/dawn.yaml"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(dawn.master_width, 2400);
    assert.equal(dawn.master_height, 3600);
    assert.equal(dawn.orientation, "portrait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dirty working tree is refused before any upload", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    const d = deps({ exec: fakeExec({ dirty: ["src/lib/foo.ts"] }) });
    const result = await runPublish({ cwd: dir, apply: true }, d);
    assert.equal(result.status, 1);
    assert.equal(d.s3.puts.length, 0);
    assert.match(result.fatals.join("\n"), /src\/lib\/foo\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing slug needs --replace-image, and identical bytes are refused", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    const bytes = readFileSync(path.join(dir, "ingest/dawn.jpg"));
    const sameSha = await sha256Hex(bytes);
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      OWNER_YAML + `slug: dawn\nmaster_sha256: ${sameSha}\n`,
    );

    const noFlag = await runPublish({ cwd: dir, apply: false }, deps());
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.fatals.join("\n"), /pass --replace-image dawn/);

    const same = await runPublish({ cwd: dir, apply: false, replaceImage: "dawn" }, deps());
    assert.equal(same.status, 1);
    assert.match(same.fatals.join("\n"), /identical/);

    // New bytes under the same slug are accepted with the flag.
    await writeMaster(path.join(dir, "ingest/dawn.jpg"), { width: 3800, height: 2500 });
    const replaced = await runPublish({ cwd: dir, apply: false, replaceImage: "dawn" }, deps());
    assert.equal(replaced.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real uploader has no client for the production masters bucket", async () => {
  const s3 = createS3(ENV);
  await assert.rejects(
    () =>
      s3.put({
        bucket: MASTERS_BUCKET_NAME,
        key: "prints/dawn.jpg",
        body: Buffer.from("x"),
        contentType: "image/jpeg",
        cacheControl: "x",
      }),
    /refusing to write nessebar-lens-masters/,
  );
});

test("the launcher spawns publish-photos and is wired as the npm script", () => {
  const root = path.join(import.meta.dirname, "..");
  const launcher = readFileSync(
    path.join(root, "scripts/publish-photos-launcher.mjs"),
    "utf8",
  );
  assert.match(launcher, /publish-photos\.mjs/);
  assert.match(launcher, /"--import",\s*\n?\s*"\.\/scripts\/register\.mjs"/);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["publish-photos"], "node scripts/publish-photos-launcher.mjs");
  // #278: the deprecated `npm run ingest` alias was removed after its
  // transition; publish-photos is the one supported command.
  assert.equal(pkg.scripts.ingest, undefined);
});

// ---------------------------------------------------------------------------
// Backfill #297: syncDecision, patchCatalogFactsYaml, createReadMastersS3,
// syncCatalogFacts
// ---------------------------------------------------------------------------

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

test("syncDecision picks the right action for each head/catalog combination", () => {
  // Master not in the bucket yet.
  assert.equal(syncDecision({ catalogSha: SHA_A, catalogFacts: undefined, head: null }), "unpromoted");

  // Sha matches, facts present → already synced.
  assert.equal(
    syncDecision({ catalogSha: SHA_A, catalogFacts: FACTS, head: { metadata: { sha256: SHA_A }, contentLength: 100 } }),
    "in-sync",
  );

  // Sha matches, facts absent → need to measure.
  assert.equal(
    syncDecision({ catalogSha: SHA_A, catalogFacts: undefined, head: { metadata: { sha256: SHA_A }, contentLength: 100 } }),
    "measure",
  );

  // Sha disagrees → refuse.
  assert.equal(
    syncDecision({ catalogSha: SHA_A, catalogFacts: FACTS, head: { metadata: { sha256: SHA_B }, contentLength: 100 } }),
    "mismatch",
  );

  // Head present but no sha256 metadata → mismatch (sha unknown but expected).
  assert.equal(
    syncDecision({ catalogSha: SHA_A, catalogFacts: undefined, head: { metadata: {}, contentLength: 100 } }),
    "mismatch",
  );
});

test("syncDecision reads sha256 case-insensitively from metadata (#297)", () => {
  // S3/HTTP lowercases metadata keys; the function must still find sha256.
  assert.equal(
    syncDecision({ catalogSha: SHA_A, catalogFacts: undefined, head: { metadata: { SHA256: SHA_A }, contentLength: 100 } }),
    "measure",
  );
});

test("patchCatalogFactsYaml appends facts to a YAML that lacks them, preserving comments", () => {
  const yaml = [
    "# owner note",
    "title: Dawn",
    "category: fine-art",
    "# written by publish-photos",
    "master_sha256: " + SHA_A,
    "image_hash: aaaaaaaa",
  ].join("\n") + "\n";

  const out = patchCatalogFactsYaml(yaml, { width: 4901, height: 3351, orientation: "landscape" });
  assert.match(out, /# owner note/);
  assert.match(out, /# written by publish-photos/);
  assert.match(out, new RegExp(`master_sha256: ${SHA_A}`));
  assert.match(out, /master_width: 4901/);
  assert.match(out, /master_height: 3351/);
  assert.match(out, /orientation: landscape/);
});

test("patchCatalogFactsYaml is idempotent: a second call does not duplicate keys", () => {
  const yaml = patchCatalogFactsYaml("title: Dawn\n", FACTS);
  const round2 = patchCatalogFactsYaml(yaml, { width: 3000, height: 2000, orientation: "portrait" });
  // Each key appears exactly once.
  assert.equal((round2.match(/^master_width:/gm) || []).length, 1);
  assert.equal((round2.match(/^master_height:/gm) || []).length, 1);
  assert.equal((round2.match(/^orientation:/gm) || []).length, 1);
  // The updated values are there.
  assert.match(round2, /master_width: 3000/);
  assert.match(round2, /master_height: 2000/);
  assert.match(round2, /orientation: portrait/);
});

test("readCatalogForSync reads published/unpublished entries with facts and text", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sync-catalog-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa",
       "master_width: 4901", "master_height: 3351", "orientation: landscape"].join("\n") + "\n",
    );
    writeFileSync(
      path.join(dir, "draft.yaml"),
      ["slug: draft", "title: Draft", "caption: c", "description: d", "alt: a", "category: fine-art",
       "published: false"].join("\n") + "\n",
    );
    writeFileSync(path.join(dir, "notes.txt"), "ignore me");

    const { entries, problems } = readCatalogForSync(dir);
    assert.equal(problems.length, 0);
    const bySlug = Object.fromEntries(entries.map((e) => [e.slug, e]));

    // Published photo: has sha + facts.
    assert.equal(bySlug.dawn.published, true);
    assert.equal(bySlug.dawn.masterSha256, SHA_A);
    assert.deepEqual(bySlug.dawn.catalogFacts, FACTS);

    // Unpublished draft: no sha, no facts.
    assert.equal(bySlug.draft.published, false);
    assert.equal(bySlug.draft.masterSha256, undefined);
    assert.equal(bySlug.draft.catalogFacts, undefined);

    // notes.txt was ignored.
    assert.equal(bySlug.notes, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts backfills a photo whose facts are missing (#297)", async () => {
  const dir = makeProject();
  try {
    // A YAML with sha + hash but no master facts.
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );

    let measured = false;
    const s3 = {
      async head(_bucket, _key) {
        return { metadata: { sha256: SHA_A }, contentLength: 1234 };
      },
      async getObject(_bucket, _key) {
        measured = true;
        return Buffer.from("jpeg-bytes");
      },
    };
    const measures = await syncCatalogFacts(
      { cwd: dir },
      {
        log: () => {},
        env: {},
        s3,
        measure: async () => FACTS,
        writeYaml: async (_path, _text) => {},
      },
    );
    assert.equal(measured, true);
    assert.equal(measures.status, 0);
    assert.deepEqual(measures.measured, [{ slug: "dawn", facts: FACTS }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts leaves an in-sync photo untouched", async () => {
  const dir = makeProject();
  try {
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa",
       "master_width: 4901", "master_height: 3351", "orientation: landscape"].join("\n") + "\n",
    );

    let headCalls = 0;
    const s3 = {
      async head(_bucket, _key) {
        headCalls++;
        return { metadata: { sha256: SHA_A }, contentLength: 1234 };
      },
      async getObject() {
        throw new Error("should not download");
      },
    };
    const measures = await syncCatalogFacts({ cwd: dir }, {
      log: () => {},
      env: {},
      s3,
      measure: async () => FACTS,
      writeYaml: async () => {},
    });
    assert.equal(headCalls, 1);
    assert.equal(measures.status, 0);
    assert.equal(measures.measured.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts refuses on a sha mismatch and writes nothing", async () => {
  const dir = makeProject();
  try {
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );

    let written = false;
    const s3 = {
      async head(_bucket, _key) {
        return { metadata: { sha256: SHA_B }, contentLength: 999 };
      },
      async getObject() {
        throw new Error("should not download on mismatch");
      },
    };
    const measures = await syncCatalogFacts(
      { cwd: dir },
      {
        log: () => {},
        env: {},
        s3,
        measure: async () => FACTS,
        writeYaml: async () => { written = true; },
      },
    );
    assert.equal(measures.status, 1);
    assert.match(measures.fatals[0], /dawn.*sha256/);
    assert.equal(written, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts refuses before writing when a later photo mismatches (#297 two-pass)", async () => {
  const dir = makeProject();
  try {
    // dawn: sha matches → "measure" (would write)
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );
    // dusk: sha mismatches → "mismatch" (should NOT write, and should NOT download)
    writeFileSync(
      path.join(dir, "content/photos/dusk.yaml"),
      ["slug: dusk", "title: Dusk", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );

    let written = false;
    let downloaded = false;
    const s3 = {
      async head(_bucket, key) {
        // dawn's master exists with matching sha; dusk's has a different sha.
        return { metadata: { sha256: key.endsWith("dusk.jpg") ? SHA_B : SHA_A }, contentLength: 100 };
      },
      async getObject() {
        downloaded = true;
        return Buffer.from("jpeg-bytes");
      },
    };
    const measures = await syncCatalogFacts(
      { cwd: dir },
      {
        log: () => {},
        env: {},
        s3,
        measure: async () => FACTS,
        writeYaml: async () => { written = true; },
      },
    );
    assert.equal(measures.status, 1);
    assert.match(measures.fatals[0], /dusk.*sha256/);
    assert.equal(written, false, "no YAML written when any photo mismatches");
    assert.equal(downloaded, false, "no master downloaded when a mismatch exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts warns on unpromoted masters and continues", async () => {
  const dir = makeProject();
  try {
    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + SHA_A, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );

    let logLines = [];
    const s3 = {
      async head(_bucket, _key) {
        return null; // master not yet promoted
      },
      async getObject() {
        throw new Error("should not download when unpromoted");
      },
    };
    const measures = await syncCatalogFacts(
      { cwd: dir },
      {
        log: (line) => logLines.push(line),
        env: {},
        s3,
        measure: async () => FACTS,
        writeYaml: async () => {},
      },
    );
    assert.equal(measures.status, 0);
    assert.equal(measures.measured.length, 0);
    assert.ok(logLines.some((l) => l.includes("dawn") && l.includes("not yet promoted")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCatalogFacts integration: real sharp JPEG measured from a fake getObject", async () => {
  const dir = makeProject();
  try {
    const jpegPath = path.join(dir, "ingest/dawn.jpg");
    await writeMaster(jpegPath, { width: 3600, height: 2400 });
    const bytes = readFileSync(jpegPath);
    const sha = await sha256Hex(bytes);

    writeFileSync(
      path.join(dir, "content/photos/dawn.yaml"),
      ["slug: dawn", "title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art",
       "master_sha256: " + sha, "image_hash: aaaaaaaa"].join("\n") + "\n",
    );

    const s3 = {
      async head(_bucket, _key) {
        return { metadata: { sha256: sha }, contentLength: bytes.length };
      },
      async getObject(_bucket, _key) {
        return bytes;
      },
    };
    let writtenText = null;
    const measures = await syncCatalogFacts(
      { cwd: dir },
      {
        log: () => {},
        env: {},
        s3,
        writeYaml: async (_path, text) => { writtenText = text; },
      },
    );
    assert.equal(measures.status, 0);
    assert.equal(measures.measured.length, 1);
    assert.match(writtenText, /master_width: 3600/);
    assert.match(writtenText, /master_height: 2400/);
    assert.match(writtenText, /orientation: landscape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createReadMastersS3 refuses any bucket but the production masters bucket", async () => {
  const s3 = createReadMastersS3({
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_MASTERS_READ_ACCESS_KEY_ID: "key",
    R2_MASTERS_READ_SECRET_ACCESS_KEY: "secret",
  });
  assert.equal(Object.keys(s3).sort().join(","), "getObject,head");
  await assert.rejects(() => s3.head("nessebar-lens-web", "k"), /refusing to read nessebar-lens-web/);
  await assert.rejects(() => s3.getObject("nessebar-lens-masters-staging", "prints/dawn.jpg"), /refusing to read/);
});

test("createReadMastersS3 refuses to construct without R2_MASTERS_READ_* creds", () => {
  assert.throws(
    () => createReadMastersS3({ R2_S3_ENDPOINT: "https://r2.example.com" }),
    /missing env: R2_MASTERS_READ_ACCESS_KEY_ID/,
  );
  assert.throws(
    () => createReadMastersS3({ R2_S3_ENDPOINT: "https://r2.example.com", R2_MASTERS_READ_ACCESS_KEY_ID: "key" }),
    /R2_MASTERS_READ_SECRET_ACCESS_KEY/,
  );
  assert.throws(
    () => createReadMastersS3({}),
    /R2_S3_ENDPOINT/,
  );
});

// ---------------------------------------------------------------------------
// #297 Option A: the sync runs automatically inside every publish run
// ---------------------------------------------------------------------------

const PUBLISHED_NO_FACTS = [
  "slug: harbour",
  "title: Harbour",
  "caption: c",
  "description: d",
  "alt: a",
  "category: fine-art",
  "master_sha256: " + SHA_A,
  "image_hash: aaaaaaaa",
].join("\n") + "\n";

test("publish refuses to start without the read-only masters creds (#297)", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    const d = deps();
    delete d.syncS3;
    const result = await runPublish({ cwd: dir, apply: false }, d);
    assert.equal(result.status, 1);
    assert.equal(d.s3.puts.length, 0);
    assert.match(result.fatals.join("\n"), /R2_MASTERS_READ_ACCESS_KEY_ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an automatic sync sha mismatch stops the publish before any upload (#297)", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    writeFileSync(path.join(dir, "content/photos/harbour.yaml"), PUBLISHED_NO_FACTS);
    const d = deps({
      syncS3: fakeSyncS3({ head: { metadata: { sha256: SHA_B }, contentLength: 1 } }),
    });
    const result = await runPublish({ cwd: dir, apply: true }, d);
    assert.equal(result.status, 1);
    assert.equal(d.s3.puts.length, 0);
    assert.match(result.fatals.join("\n"), /harbour.*sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the automatic sync backfills an existing photo and the write passes the dirty-tree gate (#297)", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    writeFileSync(path.join(dir, "content/photos/harbour.yaml"), PUBLISHED_NO_FACTS);
    const d = deps({
      syncS3: fakeSyncS3({
        head: { metadata: { sha256: SHA_A }, contentLength: 100 },
        getObject: async () => Buffer.from("jpeg"),
      }),
      // The sync's write shows up as a tree change; it must be allowlisted or
      // the run would refuse itself.
      exec: fakeExec({ dirty: ["content/photos/harbour.yaml"] }),
    });
    d.measure = async () => ({ width: 4901, height: 3351, orientation: "landscape" });
    const result = await runPublish({ cwd: dir, apply: true }, d);
    assert.equal(result.status, 0, result.fatals?.join("\n"));
    assert.ok(d.logs.some((line) => line.includes("backfilled: harbour")));
    assert.match(
      readFileSync(path.join(dir, "content/photos/harbour.yaml"), "utf8"),
      /master_width: 4901/,
    );
    assert.ok(d.exec.calls.some((c) => c.join(" ") === "git add -- content/photos"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a publish dry run reports the drift but writes no YAML (#297)", async () => {
  const dir = makeProject();
  try {
    await writeMaster(path.join(dir, "ingest/dawn.jpg"));
    writeFileSync(path.join(dir, "ingest/dawn.yaml"), OWNER_YAML);
    writeFileSync(path.join(dir, "content/photos/harbour.yaml"), PUBLISHED_NO_FACTS);
    const d = deps({
      syncS3: fakeSyncS3({
        head: { metadata: { sha256: SHA_A }, contentLength: 100 },
        getObject: async () => Buffer.from("jpeg"),
      }),
    });
    d.measure = async () => ({ width: 4901, height: 3351, orientation: "landscape" });
    const result = await runPublish({ cwd: dir, apply: false }, d);
    assert.equal(result.status, 0, result.fatals?.join("\n"));
    assert.ok(d.logs.some((line) => line.includes("would backfill: harbour")));
    assert.equal(
      readFileSync(path.join(dir, "content/photos/harbour.yaml"), "utf8"),
      PUBLISHED_NO_FACTS,
      "a dry run must leave the catalog YAML untouched",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

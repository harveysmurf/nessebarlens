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

import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_WIDTHS,
  sha256Hex,
} from "../src/lib/derivative-ladder.ts";
import {
  branchName,
  createS3,
  pairInputs,
  parseArgs,
  planWebObjects,
  prBody,
  renderCatalogYaml,
  resolutionFindings,
  runPublish,
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

async function writeMaster(file, { width = 3600, height = 2400, exif = false } = {}) {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 64, b: 32 } },
  });
  if (exif) pipeline = pipeline.withMetadata({ exif: { IFD0: { Make: "Fixture" } } });
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
    pr: undefined,
    only: undefined,
    replaceImage: undefined,
    dir: undefined,
  });
  assert.deepEqual(parseArgs(["--apply", "--only", "dawn, dusk", "--replace-image", "dawn", "--dir", "drop"]), {
    apply: true,
    promote: false,
    pr: undefined,
    only: ["dawn", "dusk"],
    replaceImage: "dawn",
    dir: "drop",
  });
  assert.deepEqual(parseArgs(["--promote", "--pr", "242", "--dir", "drop"]), {
    apply: false,
    promote: true,
    pr: 242,
    only: undefined,
    replaceImage: undefined,
    dir: "drop",
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

test("renderCatalogYaml keeps the owner's comment and appends the generated keys", () => {
  const out = renderCatalogYaml(OWNER_YAML, "dawn", "a".repeat(64), "abcd1234");
  assert.match(out, /# owner note/);
  assert.match(out, /title: Dawn/);
  assert.match(out, /slug: dawn/);
  assert.match(out, new RegExp(`master_sha256: ${"a".repeat(64)}`));
  assert.match(out, /image_hash: abcd1234/);
  assert.match(out, /# written by publish-photos/);
  // The generated keys are last.
  assert.ok(out.indexOf("image_hash") > out.indexOf("category:"));
});

test("renderCatalogYaml does not duplicate an owner slug", () => {
  const out = renderCatalogYaml("title: Dawn\nslug: dawn\n", "dawn", "a".repeat(64), "abcd1234");
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
    assert.ok(d.logs.some((line) => line.includes("fallback placeholder")));
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

test("--apply uploads 8 web objects + 1 staging master, writes the placeholder, and never production masters", async () => {
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
    assert.match(written, /# written by publish-photos/);

    // The fallback placeholder is committed: a <=1600px, EXIF-stripped JPEG.
    const placeholder = path.join(dir, "public/placeholders/dawn.jpg");
    assert.ok(existsSync(placeholder), "the placeholder must be written");
    const placeholderMeta = await sharp(readFileSync(placeholder)).metadata();
    assert.equal(placeholderMeta.format, "jpeg");
    assert.equal(placeholderMeta.width, 1600);
    assert.ok((placeholderMeta.height ?? 0) <= 1600, `height ${placeholderMeta.height}`);
    assert.equal(placeholderMeta.exif, undefined, "placeholder must have no EXIF");

    // Git: branch from origin/main, add content/photos + the placeholder, one commit.
    assert.ok(d.exec.calls.some((c) => c[0] === "git" && c[1] === "checkout" && c.includes(result.branch)));
    assert.ok(d.exec.calls.some((c) => c.join(" ") === "git add -- content/photos public/placeholders"));
    assert.ok(d.exec.calls.some((c) => c[0] === "gh" && c[1] === "pr"));
    assert.equal(result.branch, "photos/2026-10-06-dawn");
    assert.equal(result.prUrl, "https://github.com/harveysmurf/nessebarlens/pull/999");
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

test("the launcher spawns publish-photos and is wired as the npm scripts", () => {
  const root = path.join(import.meta.dirname, "..");
  const launcher = readFileSync(path.join(root, "scripts/ingest.mjs"), "utf8");
  assert.match(launcher, /publish-photos\.mjs/);
  assert.match(launcher, /"--import",\s*\n?\s*"\.\/scripts\/register\.mjs"/);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["publish-photos"], "node scripts/ingest.mjs");
  assert.equal(pkg.scripts.ingest, "node scripts/ingest.mjs");
});

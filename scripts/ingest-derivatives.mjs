#!/usr/bin/env node
/**
 * Dropped masters → private masters bucket → public derivative ladder.
 *
 *   npm run ingest                  # dry run, writes nothing
 *   npm run ingest -- --apply       # upload masters and rungs
 *   npm run ingest -- --apply --only alley-cat
 *
 * Drop JPEGs into the gitignored `ingest/` folder at the repo root, named for
 * the catalog slug they are (`alley-cat.jpg`). The original goes to
 * nessebar-lens-masters as `prints/{slug}.jpg`; sharp resizes it
 * width-driven, preserving aspect ratio, to every rung in
 * src/lib/derivative-ladder.ts and each rung goes to nessebar-lens-web as
 * `{slug}/{rung}.jpg`. Never crops: the list page's uniform tiles are a CSS
 * aspect-ratio with object-fit: cover, and the photo page is uncropped.
 *
 * Idempotent: keys are overwritten with the same bytes for the same input, so
 * a re-run after a rung change adds keys and leaves the rest alone.
 *
 * Never upsamples. A master narrower than a rung is written at its own width
 * under the rung's key, because the srcSet advertises that key and a missing
 * rung is a 404 the ladder gate exists to prevent.
 *
 * Dry run is the default. Uploading is opt-in per invocation, and
 * assertUploadIsSafe() refuses the run outright if the ladder flag is on.
 *
 * Env: R2_S3_ENDPOINT (or R2_ENDPOINT), R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY. NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED is read so the
 * guard can refuse.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

// One import, and it has no imports of its own — so this script runs under
// plain node with no loader hook, and the rung list it generates is the same
// array the site's srcSet is built from.
import {
  DERIVATIVE_JPEG_QUALITY,
  MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_WIDTHS,
  assertUploadIsSafe,
  planDerivatives,
} from "../src/lib/derivative-ladder.ts";

const DROP_DIR = "ingest";
/** A week, never `immutable`: a re-ingest overwrites the same key, and an
 *  immutable object the browser has cached cannot be corrected without a new
 *  filename. The ladder's cache-busting is the `?v=N` bump, not the header. */
const CACHE_CONTROL = "public, max-age=604800";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  // Named explicitly, because the alternative is a 403 from R2 that reads
  // like a permissions problem and sends the operator hunting the wrong thing.
  throw new Error(
    `missing env: ${names.join(" or ")} — create a .env.local in the repo ` +
      `root (gitignored) with R2_S3_ENDPOINT, R2_ACCESS_KEY_ID and ` +
      `R2_SECRET_ACCESS_KEY from the Cloudflare R2 API Tokens page, or ` +
      `export them before running.`,
  );
}

async function readDrops(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `no ${DROP_DIR}/ folder at the repo root — create it and drop the ` +
          `master JPEGs in, named for their slug (alley-cat.jpg).`,
      );
    }
    throw error;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const drops = [];
  for (const name of files) {
    const bytes = await readFile(path.join(dir, name));
    // A drop folder is whatever the photographer's machine put there, so an
    // unreadable or empty file is reported by name and skipped, not fatal. The
    // name would be rejected by the slug grammar anyway; this keeps a stray
    // .DS_Store or a half-copied file from failing the whole run.
    let width = 0;
    try {
      width = (await sharp(bytes).metadata()).width ?? 0;
    } catch {
      console.log(`  unreadable, skipping: ${name}`);
      continue;
    }
    drops.push({ name, bytes, width });
  }
  return drops;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = arg("--only");

  const endpoint = requiredEnv("R2_S3_ENDPOINT", "R2_ENDPOINT");
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });

  assertUploadIsSafe({
    mastersBucket: MASTERS_BUCKET_NAME,
    webBucket: WEB_BUCKET_NAME,
    ladderEnabled: /^(?:true|1)$/i.test(
      (process.env.NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED ?? "").trim(),
    ),
  });

  const found = await readDrops(DROP_DIR);
  const drops = only ? found.filter((d) => d.name.includes(only)) : found;
  if (drops.length === 0) {
    throw new Error(
      `no files in ${DROP_DIR}/${only ? ` matching ${only}` : ""}`,
    );
  }

  const plan = planDerivatives(
    drops.map(({ name, width }) => ({ name, width })),
    WEB_DERIVATIVE_WIDTHS,
  );

  console.log(
    `${apply ? "ingesting" : "dry run"}: ${plan.masters.length} master(s) → ` +
      `${plan.jobs.length} derivative(s); ${MASTERS_BUCKET_NAME} + ${WEB_BUCKET_NAME}`,
  );
  for (const note of plan.notes) console.log(`  note: ${note}`);
  for (const name of plan.ignoredNames) {
    console.log(`  ignored (not {slug}.jpg): ${name}`);
  }
  for (const master of plan.masters) {
    console.log(`  ${MASTERS_BUCKET_NAME}/${master.key}  (original)`);
  }
  for (const job of plan.jobs) {
    console.log(`  ${WEB_BUCKET_NAME}/${job.key}  ${job.pixels}px  (rung ${job.rung})`);
  }
  if (plan.masters.length === 0) {
    throw new Error(
      `nothing in ${DROP_DIR}/ is named {slug}.jpg — rename the masters to ` +
        `their catalog slug, or add the slug to src/lib/photos.ts first.`,
    );
  }
  if (!apply) {
    console.log("dry run — nothing uploaded. Re-run with --apply to write.");
    return;
  }

  const byName = new Map(drops.map((d) => [d.name, d.bytes]));
  let written = 0;

  for (const master of plan.masters) {
    const job = plan.jobs.find((j) => j.slug === master.slug);
    const bytes = byName.get(job.sourceName);
    if (!bytes) throw new Error(`no bytes read for ${job.sourceName}`);
    await client.send(
      new PutObjectCommand({
        Bucket: MASTERS_BUCKET_NAME,
        Key: master.key,
        Body: bytes,
        ContentType: "image/jpeg",
        CacheControl: CACHE_CONTROL,
      }),
    );
    written += 1;
    console.log(`  uploaded ${MASTERS_BUCKET_NAME}/${master.key}`);
  }

  for (const job of plan.jobs) {
    const bytes = byName.get(job.sourceName);
    if (!bytes) throw new Error(`no bytes read for ${job.sourceName}`);
    // rotate() with no argument applies the EXIF orientation first, so the
    // width-driven resize below is measured on the upright photo.
    const out = await sharp(bytes)
      .rotate()
      .resize({ width: job.pixels, withoutEnlargement: true })
      .jpeg({ quality: DERIVATIVE_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    await client.send(
      new PutObjectCommand({
        Bucket: WEB_BUCKET_NAME,
        Key: job.key,
        Body: out,
        ContentType: "image/jpeg",
        CacheControl: CACHE_CONTROL,
      }),
    );
    written += 1;
    console.log(`  uploaded ${WEB_BUCKET_NAME}/${job.key} (${out.length} bytes)`);
  }
  console.log(`done: ${written} object(s) written`);
}

main().catch((error) => {
  console.error(`ingest failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});

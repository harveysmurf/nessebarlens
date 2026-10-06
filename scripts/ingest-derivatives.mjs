#!/usr/bin/env node
/**
 * Dropped masters → private masters bucket → public derivative ladder.
 *
 *   npm run ingest                  # dry run, writes nothing
 *   npm run ingest -- --apply       # upload masters and rungs
 *   npm run ingest -- --apply --only alley-cat
 *   npm run ingest -- --apply --only alley-cat,seagulls
 *
 * Drop JPEGs into the gitignored `ingest/` folder at the repo root, named for
 * the catalog slug they are (`alley-cat.jpg`). The original goes to
 * nessebar-lens-masters as `prints/{slug}.jpg`; sharp resizes it width-driven,
 * preserving aspect ratio, to every rung in src/lib/derivative-ladder.ts, in
 * both jpg and webp, and each rung goes to nessebar-lens-web as
 * `{slug}/{hash8}/{rung}.{ext}`. Never crops: the list page's uniform tiles
 * are a CSS aspect-ratio with object-fit: cover, and the photo page is
 * uncropped.
 *
 * The key carries the master's content hash, so a changed image is a new URL
 * and the derivative objects can be served immutable.
 *
 * Idempotent: the same input produces the same keys and the same bytes, so a
 * re-run after a rung change adds keys and leaves the rest alone.
 *
 * Never upsamples. A master narrower than a rung is written at its own width
 * under the rung's key, because the srcSet advertises that key and a missing
 * rung is a 404 the ladder gate exists to prevent. A master below the top rung
 * (2000 px) is refused outright: it could never fill the largest public image.
 *
 * Dry run is the default. Uploading is opt-in per invocation, and
 * assertUploadIsSafe() refuses the run outright if the ladder flag is on.
 *
 * Env: R2_S3_ENDPOINT (or R2_ENDPOINT), R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY. NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED is read so the
 * guard can refuse.
 *
 * Loads under plain node: every import is either a package or a module with
 * no extensionless imports of its own, so no loader hook is needed. The
 * catalog is read from content/photos/*.yaml filenames rather than through
 * src/lib/photos.ts, which would pull in the git-ignored generated catalog.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

import {
  MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_CACHE_CONTROL,
  WEB_DERIVATIVE_WIDTHS,
  assertMasterIsUsable,
  assertUploadIsSafe,
  imageHash,
  planDerivatives,
  slugFromDroppedName,
} from "../src/lib/derivative-ladder.ts";
// envFlag, not a second copy of its `true|1` grammar: this file already
// reaches into src/, and a hand-inlined regex here would be the one place
// where the ladder flag accepts a value the site would read as false — so
// the guard would refuse a run the site is happily serving from, or allow
// one it is not.
import { envFlag } from "../src/lib/env.ts";
import { derivativeContentType, renderDerivative } from "./derivative-image.mjs";

const DROP_DIR = "ingest";
const CATALOG_DIR = "content/photos";
/** A week, never `immutable`: a re-ingest overwrites the master's same key.
 *  Derivative keys carry the content hash and are immutable instead. */
const MASTER_CACHE_CONTROL = "public, max-age=604800";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** `alley-cat.jpg` -> `alley-cat`. The extension is not part of a slug's
 *  identity; only the stem is compared. */
const stemOf = (name) => name.replace(/\.[^.]+$/, "");

/** `--only` is a slug list, comma-separated, not a substring needle: a needle
 *  makes `--only cat` pick up alley-cat.jpg and cathedral.jpg alike (#108). */
export function parseOnly(only) {
  const slugs = (only ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return slugs.length > 0 ? slugs : undefined;
}

/** Names whose stem is one of the requested slugs. */
export function selectDrops(names, slugs) {
  if (!slugs) return names;
  return names.filter((name) => slugs.includes(stemOf(name)));
}

/** Requested slugs the catalog does not have. Uploading a master for a slug the
 *  site cannot render is the failure this catches, so it is worth an abort. */
export function unknownSlugs(slugs, catalog) {
  return (slugs ?? []).filter((slug) => !catalog.includes(slug));
}

/**
 * Every photo slug in the catalog, from the YAML filenames. The schema makes
 * the filename the slug, and the file's own `slug:` has to equal it, so this
 * is the catalog without loading photos.ts (and its generated module).
 */
export async function catalogSlugs(dir = CATALOG_DIR) {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".yaml"))
    .map(stemOf)
    .sort();
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
    // The floor is enforced only for files that name a real slug, so a stray
    // small image the plan would ignore anyway cannot fail the run.
    if (slugFromDroppedName(name) !== null) assertMasterIsUsable(width);
    drops.push({ name, bytes, width, hash: await imageHash(bytes) });
  }
  return drops;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = parseOnly(arg("--only"));

  // Before any read of the drop folder or any R2 call, so an unknown slug costs
  // nothing and cannot half-write.
  const unknown = unknownSlugs(only, await catalogSlugs());
  if (unknown.length > 0) {
    throw new Error(
      `--only ${unknown.join(", ")} is not in the catalog ` +
        `(${CATALOG_DIR}) — add the slug there first, or check the spelling.`,
    );
  }

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
    ladderEnabled: envFlag("NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED"),
  });

  const found = await readDrops(DROP_DIR);
  const drops = selectDrops(
    found.map((d) => d.name),
    only,
  ).map((name) => found.find((d) => d.name === name));
  if (drops.length === 0) {
    throw new Error(
      `no files in ${DROP_DIR}/ matching ${only?.join(", ") ?? "every slug"}`,
    );
  }

  const plan = planDerivatives(
    drops.map(({ name, width, hash }) => ({ name, width, hash })),
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
    console.log(`  ${WEB_BUCKET_NAME}/${job.key}  ${job.pixels}px`);
  }
  if (plan.masters.length === 0) {
    throw new Error(
      `nothing in ${DROP_DIR}/ is named {slug}.jpg — rename the masters to ` +
        `their catalog slug, or add the slug to ${CATALOG_DIR} first.`,
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
        CacheControl: MASTER_CACHE_CONTROL,
      }),
    );
    written += 1;
    console.log(`  uploaded ${MASTERS_BUCKET_NAME}/${master.key}`);
  }

  for (const job of plan.jobs) {
    const bytes = byName.get(job.sourceName);
    if (!bytes) throw new Error(`no bytes read for ${job.sourceName}`);
    const out = await renderDerivative(bytes, {
      pixels: job.pixels,
      format: job.format,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: WEB_BUCKET_NAME,
        Key: job.key,
        Body: out,
        ContentType: derivativeContentType(job.format),
        CacheControl: WEB_DERIVATIVE_CACHE_CONTROL,
      }),
    );
    written += 1;
    console.log(`  uploaded ${WEB_BUCKET_NAME}/${job.key} (${out.length} bytes)`);
  }
  console.log(`done: ${written} object(s) written`);
}

// Exported for tests; the guard keeps importing this file from running an
// ingest against the operator's real credentials.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`ingest failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

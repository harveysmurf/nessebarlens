#!/usr/bin/env node
/**
 * `publish-photos -- --audit` (#244): a read-only report of what is in the
 * three R2 buckets versus what `content/photos/*.yaml` references.
 *
 * Nothing is ever deleted automatically: a replaced image, an unpublished
 * photo and a re-run whose PR never merged all leave their objects behind, on
 * purpose, because they may be behind a past buyer's download. This gives the
 * owner the list to act on deliberately.
 *
 * It lists each bucket with ListObjectsV2 (paginated) and compares the keys
 * against the catalog. Four categories of finding:
 *   - orphaned web images: `{slug}/{hash8}/…` whose hash is not the catalog's
 *     current `image_hash` for that slug (a `--replace-image`, or a preview
 *     whose PR was dropped);
 *   - masters of unpublished photos, in both masters buckets (kept for past
 *     orders, listed for information only);
 *   - missing objects: a published photo that advertises a ladder but lacks
 *     one of its eight web images, its staging master or its production master;
 *   - unknown keys: anything matching no known pattern.
 *
 * The command has no write path by construction: `createAuditS3` exposes only
 * `list` and `head`, and refuses any bucket outside the three we own. That is
 * enforced in code and pinned by a test.
 *
 *   npm run publish-photos -- --audit
 *   npm run publish-photos -- --audit --json
 *
 * Reads R2_S3_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, the same
 * owner read key the publish flow uses.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { parse as parseYaml } from "yaml";

import {
  MASTERS_BUCKET_NAME,
  PHOTO_SLUG_PATTERN,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_FORMATS,
  WEB_DERIVATIVE_WIDTHS,
  masterKeyFromSlug,
  slugFromMasterKey,
  webDerivativeKey,
} from "../src/domain/catalog/derivative-ladder";
import { validatePhotoFile } from "../src/domain/catalog/photo-schema";

const ROOT = path.join(import.meta.dirname, "..");
const CATALOG_DIR = "content/photos";

/** The three buckets the audit is allowed to read, and their display order. */
export const AUDITED_BUCKETS = [
  WEB_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  MASTERS_BUCKET_NAME,
];

/**
 * The four finding categories, in report order. `key` is the property on the
 * `auditFindings` result and the JSON output; `label` is the table header.
 */
export const AUDIT_CATEGORIES = [
  { key: "orphanedWeb", label: "Orphaned web images" },
  { key: "unpublishedMasters", label: "Masters of unpublished photos" },
  { key: "missing", label: "Missing objects" },
  { key: "unknown", label: "Unknown keys" },
];

const SLUG_BODY = PHOTO_SLUG_PATTERN.source.slice(1, -1);

/**
 * A well-formed web object key: `{slug}/{hash8}/{width}.{jpg|webp}`, built from
 * the same rung and format lists the ladder writes. Anything else in the web
 * bucket is an unknown key.
 */
const WEB_KEY_PATTERN = new RegExp(
  `^(${SLUG_BODY})/([0-9a-f]{8})/(${WEB_DERIVATIVE_WIDTHS.join("|")})\\.` +
    `(${WEB_DERIVATIVE_FORMATS.join("|")})$`,
);

/** Parses a web key into its parts, or null if it is not one. */
export function parseWebKey(key) {
  const match = WEB_KEY_PATTERN.exec(key);
  if (!match) return null;
  return { slug: match[1], hash8: match[2], width: Number(match[3]), format: match[4] };
}

/**
 * The catalog side of the comparison: every `content/photos/*.yaml`, published
 * or not, reduced to the fields the audit reads. Unpublished entries are kept
 * so their masters can be reported, not silently ignored.
 */
export function readCatalogEntries(photosDir) {
  if (!existsSync(photosDir)) {
    throw new Error(`no ${CATALOG_DIR}/ folder at ${photosDir}`);
  }
  const entries = [];
  const problems = [];
  for (const name of readdirSync(photosDir).sort()) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;
    const filename = path.basename(name, ext);
    let data;
    try {
      data = parseYaml(readFileSync(path.join(photosDir, name), "utf8"));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      continue;
    }
    const result = validatePhotoFile(filename, data);
    if (!result.ok) {
      for (const problem of result.problems) problems.push(`${name}: ${problem}`);
      continue;
    }
    entries.push({
      slug: result.photo.slug,
      published: result.photo.published,
      imageHash: result.photo.imageHash,
      masterSha256: result.photo.masterSha256,
    });
  }
  if (problems.length > 0) {
    throw new Error(`the catalog is invalid:\n  ${problems.join("\n  ")}`);
  }
  return entries;
}

/**
 * Finds every divergence between the catalog and the bucket listings. Pure:
 * the three `*Objects` arguments are `{ key, size }` arrays from `list()`.
 * Findings are sorted so two runs print the same report.
 */
export function auditFindings({
  catalog = [],
  webObjects = [],
  stagingObjects = [],
  mastersObjects = [],
} = {}) {
  const bySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
  const orphanedWeb = [];
  const unpublishedMasters = [];
  const missing = [];

  const webKeys = new Set(webObjects.map((object) => object.key));
  const stagingKeys = new Set(stagingObjects.map((object) => object.key));
  const mastersKeys = new Set(mastersObjects.map((object) => object.key));

  for (const object of webObjects) {
    const parsed = parseWebKey(object.key);
    if (!parsed) continue; // reported as unknown below
    const entry = bySlug.get(parsed.slug);
    if (entry && entry.imageHash === parsed.hash8) continue;
    orphanedWeb.push({
      slug: parsed.slug,
      bucket: WEB_BUCKET_NAME,
      key: object.key,
      size: object.size,
      currentHash: entry?.imageHash,
    });
  }

  for (const [bucket, objects] of [
    [STAGING_MASTERS_BUCKET_NAME, stagingObjects],
    [MASTERS_BUCKET_NAME, mastersObjects],
  ]) {
    for (const object of objects) {
      const slug = slugFromMasterKey(object.key);
      if (slug === null) continue; // reported as unknown below
      const entry = bySlug.get(slug);
      if (!entry || entry.published === false) {
        unpublishedMasters.push({ slug, bucket, key: object.key, size: object.size });
      }
    }
  }

  for (const entry of catalog) {
    if (entry.published === false) continue;
    // A published photo always carries an `image_hash` (schema-enforced #245),
    // so this guard is defensive; without a hash there is no ladder to check.
    if (typeof entry.imageHash !== "string") continue;
    for (const width of WEB_DERIVATIVE_WIDTHS) {
      for (const format of WEB_DERIVATIVE_FORMATS) {
        const key = webDerivativeKey(entry.slug, entry.imageHash, width, format);
        if (!webKeys.has(key)) {
          missing.push({ slug: entry.slug, bucket: WEB_BUCKET_NAME, key });
        }
      }
    }
    const masterKey = masterKeyFromSlug(entry.slug);
    if (!stagingKeys.has(masterKey)) {
      missing.push({ slug: entry.slug, bucket: STAGING_MASTERS_BUCKET_NAME, key: masterKey });
    }
    if (!mastersKeys.has(masterKey)) {
      missing.push({ slug: entry.slug, bucket: MASTERS_BUCKET_NAME, key: masterKey });
    }
  }

  const unknown = [];
  for (const object of webObjects) {
    if (!parseWebKey(object.key)) {
      unknown.push({ bucket: WEB_BUCKET_NAME, key: object.key, size: object.size });
    }
  }
  for (const [bucket, objects] of [
    [STAGING_MASTERS_BUCKET_NAME, stagingObjects],
    [MASTERS_BUCKET_NAME, mastersObjects],
  ]) {
    for (const object of objects) {
      if (slugFromMasterKey(object.key) === null) {
        unknown.push({ bucket, key: object.key, size: object.size });
      }
    }
  }

  const byLocation = (a, b) => {
    if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
    const wa = parseWebKey(a.key);
    const wb = parseWebKey(b.key);
    // Web keys read naturally by width (400 before 1500) rather than by string
    // (`"1500"` sorts before `"400"`). Everything else is a plain key sort.
    if (wa && wb) {
      return (
        wa.slug.localeCompare(wb.slug) ||
        wa.hash8.localeCompare(wb.hash8) ||
        wa.width - wb.width ||
        wa.format.localeCompare(wb.format)
      );
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };

  return {
    orphanedWeb: orphanedWeb.sort(byLocation),
    unpublishedMasters: unpublishedMasters.sort(byLocation),
    missing: missing.sort(byLocation),
    unknown: unknown.sort(byLocation),
  };
}

/** Bytes as a short human string: `0 B`, `1.0 KB`, `2.3 MB`. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes ?? 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The sum of the numeric `size` fields of a finding list. */
function totalBytes(items) {
  return items.reduce((sum, item) => sum + (typeof item.size === "number" ? item.size : 0), 0);
}

/** The plain-text report: one block per category with its count and total size. */
export function formatReport(findings) {
  const lines = [];
  for (const { key, label } of AUDIT_CATEGORIES) {
    const items = findings[key];
    const total = totalBytes(items);
    const bytes = items.some((item) => typeof item.size === "number")
      ? `, ${formatBytes(total)}`
      : "";
    lines.push(`${label}: ${items.length}${bytes}`);
    for (const item of items) {
      const where = `${item.bucket}/${item.key}`;
      const size = typeof item.size === "number" ? `  ${formatBytes(item.size)}` : "";
      lines.push(`  ${where}${size}`);
    }
  }
  const any = AUDIT_CATEGORIES.some(({ key }) => findings[key].length > 0);
  if (!any) lines.push("No findings: the buckets match the catalog.");
  return lines.join("\n");
}

/** The `--json` shape: every category with its count, total bytes and items. */
export function auditJson(findings) {
  return {
    categories: AUDIT_CATEGORIES.map(({ key, label }) => ({
      key,
      label,
      count: findings[key].length,
      totalBytes: totalBytes(findings[key]),
      items: findings[key],
    })),
  };
}

/**
 * A read-only S3 client for the three buckets we own. It exposes only `list`
 * and `head` — no put, no delete — and refuses a bucket outside the three
 * before any request is made, so the audit cannot write even by mistake.
 */
export function createAuditS3(env) {
  const client = new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT ?? env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  const allowed = new Set(AUDITED_BUCKETS);
  const assertAllowed = (bucket) => {
    if (!allowed.has(bucket)) {
      throw new Error(
        `refusing to read ${bucket}: the audit only reads ${[...allowed].join(", ")}`,
      );
    }
  };
  return {
    async list(bucket) {
      assertAllowed(bucket);
      const objects = [];
      let token;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key === undefined) continue;
          objects.push({ key: object.Key, size: object.Size ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async head(bucket, key) {
      assertAllowed(bucket);
      try {
        const object = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { metadata: object.Metadata ?? {}, contentLength: object.ContentLength };
      } catch (error) {
        if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}

function requiredEnv(names, env) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  throw new Error(
    `missing env: ${names.join(" or ")} — put R2_S3_ENDPOINT, R2_ACCESS_KEY_ID ` +
      `and R2_SECRET_ACCESS_KEY in .env.local at the repo root, or export them.`,
  );
}

/**
 * Lists the three buckets, compares them to the catalog and prints the report.
 * All side effects go through `deps`; returns `{ status, findings }`.
 */
export async function runAudit(options = {}, deps = {}) {
  const cwd = options.cwd ?? ROOT;
  const log = deps.log ?? ((line) => console.log(line));
  const env = deps.env ?? process.env;

  const catalog = deps.catalog ?? readCatalogEntries(path.resolve(cwd, CATALOG_DIR));

  let s3 = deps.s3;
  if (!s3) {
    requiredEnv(["R2_S3_ENDPOINT", "R2_ENDPOINT"], env);
    requiredEnv(["R2_ACCESS_KEY_ID"], env);
    requiredEnv(["R2_SECRET_ACCESS_KEY"], env);
    s3 = createAuditS3(env);
  }

  const [webObjects, stagingObjects, mastersObjects] = await Promise.all(
    AUDITED_BUCKETS.map((bucket) => s3.list(bucket)),
  );
  const findings = auditFindings({
    catalog,
    webObjects,
    stagingObjects,
    mastersObjects,
  });

  log(options.json ? JSON.stringify(auditJson(findings), null, 2) : formatReport(findings));
  return { status: 0, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAudit({ cwd: ROOT }).then(
    (result) => {
      process.exitCode = result.status;
    },
    (error) => {
      console.error(`audit failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}

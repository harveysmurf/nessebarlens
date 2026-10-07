#!/usr/bin/env node
/**
 * Release gate (#243): refuse to deploy production when a published photo's
 * full-res master is missing from, or differs from, what the catalog lists.
 *
 * A forgotten `publish-photos --promote` is invisible to a green build: the
 * catalog advertises a photo, the site sells it, and the failure only surfaces
 * when a buyer's download 404s or Prodigi gets no asset. This runs in the
 * `production` job after the build is verified and before any production change,
 * so a missing master stops the release with production still on its current
 * version.
 *
 * It reads the compiled catalog (`src/generated/catalog.ts`) the app serves —
 * the same module `getPhoto()` reads — which the deploy job regenerates from the
 * checked-out commit. For every published photo it `HeadObject`s
 * `nessebar-lens-masters/prints/{slug}.jpg` and asserts the object exists, is
 * non-empty, and carries `sha256` user metadata equal to the catalog's
 * `master_sha256` (the value `--promote` writes).
 *
 * The uploader is read-only by construction: the one bucket it may touch is the
 * production masters bucket, and it only ever issues HeadObject.
 *
 *   npm run verify:masters
 *
 * Reads R2_S3_ENDPOINT, R2_MASTERS_READ_ACCESS_KEY_ID and
 * R2_MASTERS_READ_SECRET_ACCESS_KEY — a read-only token scoped to Object Read
 * on nessebar-lens-masters, held only in the production Environment.
 *
 * The pure decision is exported so tests can drive it with a fake S3 client.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  MASTER_SHA256_PATTERN,
  MASTERS_BUCKET_NAME,
  masterKeyFromSlug,
} from "../src/lib/derivative-ladder.ts";
import { PHOTOS } from "../src/generated/catalog.ts";

/** The S3 user-metadata key that carries the master's SHA-256. */
const MASTER_METADATA_KEY = "sha256";

/**
 * The transitional placeholder catalog (#239): slugs that are listed but have
 * no full-res master yet, so the gate must not fail the release on them. The
 * list is exactly the photos with no `masterSha256`; a photo that advertises a
 * master is always checked. #245 deletes this list once real photos are live.
 */
export const ALLOWLISTED_SLUGS = new Set([
  "alley-cat",
  "autumn",
  "boat-hull",
  "chapel-light",
  "cobblestones",
  "craftsman",
  "dawn",
  "evening-wall",
  "fishermen",
  "fortress",
  "harbor-mist",
  "isthmus",
  "market-day",
  "net-menders",
  "salt-air",
  "seagulls",
  "shadow-street",
  "stone-arch",
  "windmill",
  "winter-pier",
]);

/** Case-insensitive read of one S3 user-metadata value; HTTP lowercases keys. */
export function metadataValue(metadata, name) {
  if (!metadata) return undefined;
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value);
  }
  return undefined;
}

/**
 * Checks every published photo against the production masters bucket. Returns
 * an array of human-readable failures (`dawn: missing`) — empty means the
 * catalog may ship. Every photo is checked so one run reports all problems.
 */
export async function verifyMasters({
  photos = PHOTOS,
  s3,
  allowlist = ALLOWLISTED_SLUGS,
  log = () => {},
} = {}) {
  const failures = [];
  for (const photo of photos) {
    if (photo.published === false) continue;
    if (allowlist.has(photo.slug)) {
      log(`skipped (placeholder allow-list): ${photo.slug}`);
      continue;
    }
    // The compiled catalog stores the YAML's `master_sha256` as `masterSha256`.
    if (
      typeof photo.masterSha256 !== "string" ||
      !MASTER_SHA256_PATTERN.test(photo.masterSha256)
    ) {
      failures.push(`${photo.slug}: no master_sha256 in the catalog`);
      continue;
    }

    let head;
    try {
      head = await s3.head(MASTERS_BUCKET_NAME, masterKeyFromSlug(photo.slug));
    } catch (error) {
      failures.push(`${photo.slug}: head failed: ${error?.message ?? error}`);
      continue;
    }
    if (!head) {
      failures.push(`${photo.slug}: missing from ${MASTERS_BUCKET_NAME}`);
      continue;
    }
    if (!(head.contentLength > 0)) {
      failures.push(`${photo.slug}: empty object`);
      continue;
    }
    const stored = metadataValue(head.metadata, MASTER_METADATA_KEY);
    if (stored !== photo.masterSha256) {
      failures.push(
        `${photo.slug}: sha256 mismatch (catalog ${photo.masterSha256.slice(0, 8)}…, ` +
          `bucket ${stored ? `${stored.slice(0, 8)}…` : "unset"})`,
      );
    }
  }
  return failures;
}

/**
 * A read-only S3 client whose one bucket is the production masters bucket. A
 * call for any other bucket throws before a request is made.
 */
export function createMastersS3(env) {
  const client = new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_MASTERS_READ_ACCESS_KEY_ID,
      secretAccessKey: env.R2_MASTERS_READ_SECRET_ACCESS_KEY,
    },
  });
  return {
    async head(bucket, key) {
      if (bucket !== MASTERS_BUCKET_NAME) {
        throw new Error(
          `refusing to read ${bucket}: verify-masters only reads ${MASTERS_BUCKET_NAME}`,
        );
      }
      try {
        const object = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          metadata: object.Metadata ?? {},
          contentLength: object.ContentLength,
        };
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
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `missing env: ${missing.join(", ")} — these are production-Environment ` +
        `secrets for the read-only masters check (#243).`,
    );
  }
}

/** The published photos that actually need a master checked (not allow-listed). */
export function photosToVerify(photos = PHOTOS, allowlist = ALLOWLISTED_SLUGS) {
  return photos.filter(
    (photo) => photo.published !== false && !allowlist.has(photo.slug),
  );
}

export async function main(env = process.env, photos = PHOTOS) {
  // While every published photo is still an allow-listed placeholder there is
  // nothing to read, so the read-only token is not required yet: the gate is a
  // clean no-op rather than a red release for a credential nobody needs. It is
  // needed the moment the first real photo is published — which is exactly when
  // `photosToVerify` stops being empty.
  if (photosToVerify(photos).length === 0) {
    console.log(
      "verify-masters: no published photo needs a master yet (placeholder allow-list); nothing to verify",
    );
    return 0;
  }
  requiredEnv(
    ["R2_S3_ENDPOINT", "R2_MASTERS_READ_ACCESS_KEY_ID", "R2_MASTERS_READ_SECRET_ACCESS_KEY"],
    env,
  );
  const failures = await verifyMasters({
    photos,
    s3: createMastersS3(env),
    log: (line) => console.log(line),
  });
  if (failures.length === 0) {
    console.log(`verify-masters: all published masters present and matching`);
    return 0;
  }
  console.error(`verify-masters: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nA photo is listed but its full-res master is missing or stale. Upload it " +
      "with `npm run publish-photos -- --promote --pr <n>` and re-run the release. " +
      "If the photo should not ship yet, remove its content/photos/<slug>.yaml.",
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`verify-masters failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}

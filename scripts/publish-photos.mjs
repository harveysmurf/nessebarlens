#!/usr/bin/env node
/**
 * Publish dropped photos end to end: validate a `{slug}.jpg` + `{slug}.yaml`
 * pair, upload the public web ladder (#240) and the staging master (#212),
 * write the catalog YAML and the committed fallback placeholder (#257), and
 * open one PR for the run.
 *
 *   npm run publish-photos                       # dry run: validate + print the plan
 *   npm run publish-photos -- --apply            # upload, write YAML, open PR
 *   npm run publish-photos -- --apply --only dawn,dusk
 *   npm run publish-photos -- --apply --replace-image dawn
 *   npm run publish-photos -- --promote --pr 42  # upload the masters, auto-merge
 *   npm run publish-photos -- --audit            # read-only bucket vs catalog report (#244)
 *
 * `--audit` is handled in scripts/audit-photos.mjs; it never writes. The rest
 * of this header describes the publish and promote paths.
 *
 * Drop folder defaults to the gitignored `ingest/`; `--dir <path>` overrides.
 * Input is one JPEG and one YAML per slug. The `--apply` uploader has no client
 * for the production masters bucket: it may only write the public web bucket
 * and the staging masters bucket, and `assertUploadIsSafe` names exactly those.
 * `--apply` also commits `public/placeholders/{slug}.jpg`, the one image the
 * site serves with no R2 at all (the ladder-off gallery tile and checkout's
 * product image), so a publish PR carries its fallback without a manual step.
 *
 * `--promote --pr <n>` is the second half (#242). It reads the PR's changed
 * `content/photos/*.yaml` from the PR head, confirms the PR is the owner's and
 * open against `main`, then hashes each local `ingest/{slug}.jpg` and refuses
 * unless it is byte-for-byte the master that was previewed. It is the one
 * place the production masters bucket is written: unmodified bytes at
 * `prints/{slug}.jpg` with user metadata `sha256=<master_sha256>`, which the
 * release check (#243) reads. Its uploader has no client for the web or
 * staging buckets, so those are never touched here.
 *
 * The web keys are content-addressed and the staging master is a 2500 px
 * downscale, so a re-run is idempotent; web objects that already exist are
 * skipped. Any failure before the writes leaves no YAML and opens no PR.
 *
 * Every pure decision lives in an exported function so it can be unit-tested
 * without S3, git or gh; `runPublish` takes those as injected dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse as parseYaml, parseDocument, Pair, Scalar } from "yaml";

import {
  MASTER_SHA256_PATTERN,
  MASTERS_BUCKET_NAME,
  PHOTO_SLUG_PATTERN,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_CACHE_CONTROL,
  WEB_DERIVATIVE_FORMATS,
  WEB_DERIVATIVE_WIDTHS,
  assertUploadIsSafe,
  masterKeyFromSlug,
  sha256Hex,
  slugFromDroppedName,
  webDerivativeKey,
} from "../src/lib/derivative-ladder.ts";
import { validatePhotoFile } from "../src/lib/photo-schema.ts";
import {
  derivativeContentType,
  masterDimensions,
  renderDerivative,
  renderPlaceholder,
  renderStagingMaster,
} from "./derivative-image.mjs";
import { runAudit } from "./audit-photos.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DEFAULT_DIR = "ingest";
const CATALOG_DIR = "content/photos";
const PLACEHOLDERS_DIR = "public/placeholders";
const GENERATED_KEYS = ["master_sha256", "image_hash"];
/** A re-ingest overwrites the staging master's same key; a week is enough. */
const STAGING_MASTER_CACHE_CONTROL = "public, max-age=604800";
/**
 * Masters are downloaded by buyers' signed links, never served from a shared
 * cache, so the promoted object must not be cached at all (#242).
 */
const PROMOTE_MASTER_CACHE_CONTROL = "private, no-store";
/** The S3 user-metadata key that carries the master's SHA-256. */
const MASTER_METADATA_KEY = "sha256";
const MIN_LONG_EDGE = 3500;
const WARN_LONG_EDGE = 6000;

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Parses the CLI flags. Unknown flags are left to the caller's argv scan. */
export function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const onlyRaw = valueOf("--only");
  const only = onlyRaw
    ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const prRaw = valueOf("--pr");
  const pr = prRaw === undefined ? undefined : Number(prRaw);
  return {
    apply: has("--apply"),
    promote: has("--promote"),
    audit: has("--audit"),
    json: has("--json"),
    pr: Number.isInteger(pr) && pr > 0 ? pr : undefined,
    only: only && only.length > 0 ? only : undefined,
    replaceImage: valueOf("--replace-image"),
    dir: valueOf("--dir"),
  };
}

/**
 * Pairs `{slug}.jpg` with `{slug}.yaml`. A missing half is an error; anything
 * that is neither a valid-slug JPEG nor a valid-slug YAML is ignored by name.
 */
export function pairInputs(names) {
  const jpgs = new Map();
  const yamls = new Map();
  const ignored = [];
  for (const name of [...names].sort()) {
    const jpgSlug = slugFromDroppedName(name);
    if (jpgSlug !== null) {
      jpgs.set(jpgSlug, name);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      const stem = name.slice(0, -ext.length);
      if (PHOTO_SLUG_PATTERN.test(stem)) {
        yamls.set(stem, name);
        continue;
      }
    }
    ignored.push(name);
  }

  const slugs = [...new Set([...jpgs.keys(), ...yamls.keys()])].sort();
  const pairs = [];
  const problems = [];
  for (const slug of slugs) {
    const jpeg = jpgs.get(slug);
    const yaml = yamls.get(slug);
    if (!jpeg) {
      problems.push(`${slug}: has ${yaml} but no ${slug}.jpg`);
    } else if (!yaml) {
      problems.push(`${slug}: has ${jpeg} but no ${slug}.yaml`);
    } else {
      pairs.push({ slug, jpeg, yaml });
    }
  }
  return { pairs, problems, ignored };
}

/**
 * The resolution floor and warning. 3499 px is refused; 3500 px warns about a
 * 70x100 cm print; 6000 px and up is clean.
 */
export function resolutionFindings(longEdge) {
  const errors = [];
  const warnings = [];
  if (longEdge < MIN_LONG_EDGE) {
    errors.push(`long edge ${longEdge}px is below the ${MIN_LONG_EDGE}px minimum`);
  } else if (longEdge < WARN_LONG_EDGE) {
    const dpi = Math.round(longEdge / (100 / 2.54));
    warnings.push(`long edge ${longEdge}px: 70x100 cm will print at ~${dpi} dpi`);
  }
  return { errors, warnings };
}

/**
 * Every per-photo problem, collected rather than thrown, so a batch reports
 * all of them at once. `existing` is the catalog entry for the slug, if any;
 * `newSha256` is the full hash of the new master.
 */
export function validatePhoto({
  slug,
  yamlText,
  longEdge,
  existing,
  newSha256,
  replaceImage,
}) {
  const errors = [];
  const warnings = [];

  let data;
  try {
    data = parseYaml(yamlText);
  } catch (error) {
    return { data: undefined, errors: [`${slug}.yaml: ${error.message}`], warnings };
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of GENERATED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(
          `${slug}.yaml: ${key} must be absent in the input; publish-photos writes it`,
        );
      }
    }
  }

  const schema = validatePhotoFile(slug, data);
  if (!schema.ok) {
    for (const problem of schema.problems) errors.push(`${slug}.yaml: ${problem}`);
  }

  const resolution = resolutionFindings(longEdge);
  errors.push(...resolution.errors);
  warnings.push(...resolution.warnings);

  if (existing) {
    if (replaceImage !== slug) {
      errors.push(
        `${slug}: already in ${CATALOG_DIR} — pass --replace-image ${slug} to replace it`,
      );
    } else if (existing.masterSha256 === newSha256) {
      errors.push(`${slug}: the new image is identical (same master_sha256); nothing to replace`);
    }
  }

  return { data, errors, warnings };
}

/** The eight web objects one photo publishes: four widths × two formats. */
export function planWebObjects(slug, hash8) {
  const objects = [];
  for (const width of WEB_DERIVATIVE_WIDTHS) {
    for (const format of WEB_DERIVATIVE_FORMATS) {
      objects.push({
        key: webDerivativeKey(slug, hash8, width, format),
        width,
        format,
        contentType: derivativeContentType(format),
      });
    }
  }
  return objects;
}

/**
 * The owner's YAML with the generated keys appended and the three kept under
 * one comment. The Document API preserves the owner's comments and key order.
 */
export function renderCatalogYaml(ownerText, slug, masterSha256, imageHash) {
  const doc = parseDocument(ownerText);
  const map = doc.contents;
  const generated = [];

  if (!map.has("slug")) {
    map.add(new Pair(new Scalar("slug"), new Scalar(slug)));
    generated.push("slug");
  } else {
    map.set("slug", slug);
  }
  map.add(new Pair(new Scalar("master_sha256"), new Scalar(masterSha256)));
  generated.push("master_sha256");
  map.add(new Pair(new Scalar("image_hash"), new Scalar(imageHash)));
  generated.push("image_hash");

  const keyOf = (pair) =>
    pair.key && typeof pair.key === "object" ? pair.key.value : pair.key;
  const first = map.items.find((pair) => keyOf(pair) === generated[0]);
  if (first && typeof first.key === "object") {
    first.key.commentBefore = " written by publish-photos";
  }
  return doc.toString();
}

/** `photos/<YYYY-MM-DD>-<first>[-and-N-more]`. */
export function branchName(date, slugs) {
  const [first, ...rest] = slugs;
  const suffix = rest.length > 0 ? `-and-${rest.length}-more` : "";
  return `photos/${date}-${first}${suffix}`;
}

/** The PR body: a per-photo table, the staging note, and the promote step. */
export function prBody(plans, branchDate) {
  const lines = [
    `Publish ${plans.length} photo(s) via \`publish-photos\`.`,
    "",
    "| slug | title | category | long edge | warnings |",
    "|---|---|---|---|---|",
  ];
  for (const plan of plans) {
    const warnings = plan.warnings.length > 0 ? plan.warnings.join("; ") : "—";
    lines.push(
      `| ${plan.slug} | ${plan.title} | ${plan.category} | ${plan.longEdge}px | ${warnings} |`,
    );
  }
  lines.push(
    "",
    `The preview reads **staging masters (2500 px)** from \`${STAGING_MASTERS_BUCKET_NAME}\`;`,
    "the production masters bucket is not written by this PR.",
    `Each photo also commits its fallback \`${PLACEHOLDERS_DIR}/{slug}.jpg\` (#257).`,
    "",
    `Next: check the preview, then \`npm run publish-photos -- --promote --pr <n>\` (#242),`,
    "which uploads the full-res masters and enables auto-merge.",
    "",
    `_Generated ${branchDate}._`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Promote decisions (#242)
// ---------------------------------------------------------------------------

/**
 * The folders a publish PR is allowed to touch: the catalog entry and the
 * committed fallback placeholder (#257). Anything else means the PR is not a
 * photo publish and `--promote` must not auto-merge it.
 */
export const PROMOTE_ALLOWED_DIRS = [CATALOG_DIR, PLACEHOLDERS_DIR];

/**
 * Splits a PR's `files` (gh's `pr view --json files` shape, `{path, changeType}`)
 * into the `content/photos/*.yaml` it changed and anything it touched outside
 * the allowed folders. The PR head is the authority on what to promote, not
 * `ingest/`.
 */
export function selectPromoteFiles(files) {
  const outside = [];
  const yamls = [];
  for (const file of files ?? []) {
    const filePath = file.path ?? file.filename ?? "";
    const changeType = String(file.changeType ?? file.status ?? "").toUpperCase();
    const deleted = changeType === "DELETED" || changeType === "REMOVED";

    if (filePath.startsWith(`${CATALOG_DIR}/`)) {
      if (/\.ya?ml$/.test(filePath)) {
        yamls.push({
          path: filePath,
          slug: path.basename(filePath).replace(/\.ya?ml$/, ""),
          changeType,
        });
      }
      // A non-YAML file inside content/photos/ is not a catalog entry.
      continue;
    }

    if (filePath.startsWith(`${PLACEHOLDERS_DIR}/`)) {
      // A publish only adds the fallback JPEG. A deletion or any other
      // extension under here is not a photo publish, so it is refused.
      if (deleted || !filePath.endsWith(".jpg")) outside.push(filePath);
      continue;
    }

    outside.push(filePath);
  }
  return { outside, yamls };
}

/**
 * A PR is promotable only when it is open, targets `main`, was opened by the
 * currently authenticated owner (only their local masters are trusted), and
 * changes nothing outside the allowed folders (`content/photos/` plus the
 * committed `public/placeholders/`). A deleted catalog entry cannot be
 * promoted. Returns every problem, not just the first.
 */
export function verifyPromotePr(pull, currentUser) {
  const errors = [];
  const number = pull.number;
  if (String(pull.state).toUpperCase() !== "OPEN") {
    errors.push(`PR #${number} is not open (state: ${pull.state})`);
  }
  if (pull.baseRefName !== "main") {
    errors.push(`PR #${number} targets ${pull.baseRefName ?? "?"}, not main`);
  }
  const author =
    pull.author && typeof pull.author === "object"
      ? pull.author.login
      : pull.author;
  // GitHub logins are case-insensitive. A missing authenticated user is
  // reported by the caller (gh api user failed), so it is not guessed at here.
  if (
    typeof currentUser === "string" &&
    author?.toLowerCase() !== currentUser.toLowerCase()
  ) {
    errors.push(
      `PR #${number} was opened by ${author ?? "unknown"}, not the owner (${currentUser})`,
    );
  }
  const { outside, yamls } = selectPromoteFiles(pull.files);
  if (outside.length > 0) {
    errors.push(
      `PR #${number} changes files outside ` +
        `${PROMOTE_ALLOWED_DIRS.map((dir) => `${dir}/`).join(" and ")}: ` +
        outside.join(", "),
    );
  }
  const live = [];
  for (const yaml of yamls) {
    if (yaml.changeType === "DELETED" || yaml.changeType === "REMOVED") {
      errors.push(`PR #${number} deletes ${yaml.path}`);
    } else {
      live.push(yaml);
    }
  }
  if (live.length === 0 && errors.length === 0) {
    errors.push(`PR #${number} changes no ${CATALOG_DIR}/*.yaml`);
  }
  return { errors, yamls: live };
}

/** Case-insensitive read of one S3 user-metadata value; HTTP lowercases keys. */
export function metadataValue(metadata, name) {
  if (!metadata) return undefined;
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value);
  }
  return undefined;
}

/**
 * What to do with one master. Absent → upload. Already stored with the same
 * sha256 → skip (a re-run is idempotent). A different sha256 is refused, unless
 * the PR modified an existing catalog entry (a `--replace-image`), in which
 * case the fixed `prints/{slug}.jpg` key is deliberately overwritten.
 */
export function planPromoteAction({ existing, masterSha256, isReplace }) {
  if (!existing) return { action: "upload" };
  const stored = metadataValue(existing.metadata, MASTER_METADATA_KEY);
  if (stored === masterSha256) return { action: "skip" };
  if (isReplace) return { action: "replace" };
  return {
    action: "refuse",
    reason:
      `already holds a different master (sha256 ${stored ?? "unset"}); ` +
      `re-run publish-photos with --replace-image to overwrite it`,
  };
}

/** owner/repo from a PR URL, so the contents-API endpoints can be built. */
export function repoFromPrUrl(url) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(
    url ?? "",
  );
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Whether a modified catalog entry is a `--replace-image`: its head
 * `master_sha256` differs from the one on the base branch. A caption-only edit
 * (same hash) is not a replacement, so it can never overwrite a different
 * production master. An unreadable base is treated as not-a-replacement — the
 * safe direction.
 */
export function isReplacement({
  changeType,
  baseMasterSha256,
  headMasterSha256,
}) {
  return (
    changeType === "MODIFIED" &&
    typeof baseMasterSha256 === "string" &&
    baseMasterSha256 !== headMasterSha256
  );
}

/**
 * Reads one file from a PR's tree via the contents API. Returns the raw text,
 * or { ok: false } with the gh error. `ref` is the PR head or base ref.
 */
async function readPrFile(exec, cwd, repo, filePath, ref) {
  const endpoint =
    `repos/${repo.owner}/${repo.repo}/contents/${filePath}` +
    `?ref=${encodeURIComponent(ref)}`;
  const file = await exec(
    "gh",
    ["api", endpoint, "-H", "Accept: application/vnd.github.raw"],
    { cwd },
  );
  if (file.status !== 0) {
    return { ok: false, error: file.stderr.trim() || "gh api failed" };
  }
  return { ok: true, text: file.stdout };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

function runCommand(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * An S3 uploader with no client for the production masters bucket: the allowed
 * set is the public web bucket and the staging masters bucket, and a call for
 * anything else throws before a request is made.
 */
export function createS3(env) {
  const client = new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT ?? env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  const allowed = new Set([WEB_BUCKET_NAME, STAGING_MASTERS_BUCKET_NAME]);
  const assertAllowed = (bucket) => {
    if (!allowed.has(bucket)) {
      throw new Error(
        `refusing to write ${bucket}: publish-photos only writes ${[...allowed].join(", ")}`,
      );
    }
  };
  return {
    async exists(bucket, key) {
      assertAllowed(bucket);
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw error;
      }
    },
    async put({ bucket, key, body, contentType, cacheControl }) {
      assertAllowed(bucket);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      );
    },
  };
}

/**
 * The promote uploader, whose only writable bucket is the production masters
 * bucket. A call for the web or staging bucket throws before a request is made,
 * so `--promote` can never touch what `--apply` wrote (#242).
 *
 * `head` returns the two fields the read-back needs — the user metadata and the
 * byte length — or null for a missing object, rather than the SDK's envelope.
 */
export function createPromoteS3(env) {
  const client = new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT ?? env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  const allowed = new Set([MASTERS_BUCKET_NAME]);
  const assertAllowed = (bucket) => {
    if (!allowed.has(bucket)) {
      throw new Error(
        `refusing to write ${bucket}: publish-photos --promote only writes ${MASTERS_BUCKET_NAME}`,
      );
    }
  };
  return {
    async head(bucket, key) {
      assertAllowed(bucket);
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
    async put({ bucket, key, body, contentType, cacheControl, metadata }) {
      assertAllowed(bucket);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata,
        }),
      );
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

async function readDirNames(dir) {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `no ${path.relative(ROOT, dir) || dir}/ folder — create it and drop ` +
          `{slug}.jpg + {slug}.yaml pairs in.`,
      );
    }
    throw error;
  }
}

function readExistingCatalog(entryPath) {
  if (!existsSync(entryPath)) return null;
  try {
    const data = parseYaml(readFileSync(entryPath, "utf8"));
    if (data && typeof data === "object") {
      return { masterSha256: data.master_sha256 };
    }
  } catch {
    // A malformed catalog file is treated as existing-but-hash-unknown; the
    // owner should fix it, and a replace with no known hash is allowed.
  }
  return { masterSha256: undefined };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Validates the drop folder, and with `apply` uploads, writes YAML and opens
 * the PR. Returns { status, prUrl? }; all side effects go through `deps`.
 */
export async function runPublish(options, deps = {}) {
  const cwd = options.cwd ?? ROOT;
  const dir = path.resolve(cwd, options.dir ?? DEFAULT_DIR);
  const catalogDir = path.resolve(cwd, CATALOG_DIR);
  const log = deps.log ?? ((line) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? runCommand;
  const s3 = deps.s3 ?? createS3(env);

  const names = await readDirNames(dir);
  const { pairs: allPairs, problems: pairProblems, ignored } = pairInputs(names);
  const fatals = [...pairProblems];
  for (const name of ignored) log(`ignored (not {slug}.jpg / {slug}.yaml): ${name}`);

  const wanted = options.only
    ? allPairs.filter((pair) => options.only.includes(pair.slug))
    : allPairs;
  if (options.only) {
    for (const slug of options.only) {
      if (!allPairs.some((pair) => pair.slug === slug)) {
        fatals.push(`--only ${slug} is not in ${path.relative(ROOT, dir) || dir}/`);
      }
    }
  }

  const plans = [];
  for (const pair of wanted) {
    const bytes = await readFile(path.join(dir, pair.jpeg));
    const yamlText = await readFile(path.join(dir, pair.yaml), "utf8");
    const { width, height } = await masterDimensions(bytes);
    const longEdge = Math.max(width, height);
    const masterSha256 = await sha256Hex(bytes);
    const hash8 = masterSha256.slice(0, 8);
    const existing = readExistingCatalog(path.join(catalogDir, `${pair.slug}.yaml`));
    const { data, errors, warnings } = validatePhoto({
      slug: pair.slug,
      yamlText,
      longEdge,
      existing,
      newSha256: masterSha256,
      replaceImage: options.replaceImage,
    });
    fatals.push(...errors);
    plans.push({
      slug: pair.slug,
      title: data && typeof data.title === "string" ? data.title : "",
      category: data && typeof data.category === "string" ? data.category : "",
      longEdge,
      warnings,
      hash8,
      masterSha256,
      bytes,
      yamlText,
      webObjects: planWebObjects(pair.slug, hash8),
      stagingKey: masterKeyFromSlug(pair.slug),
      yamlPath: path.join(catalogDir, `${pair.slug}.yaml`),
      placeholderPath: path.join(cwd, PLACEHOLDERS_DIR, `${pair.slug}.jpg`),
    });
  }

  if (plans.length === 0 && fatals.length === 0) {
    fatals.push(`no {slug}.jpg + {slug}.yaml pairs in ${dir}`);
  }

  const slugs = plans.map((plan) => plan.slug);
  const date = now().toISOString().slice(0, 10);
  const branch = branchName(date, slugs);
  const commitMessage = `feat(photos): publish ${slugs.join(", ")}`;
  const body = prBody(plans, date);

  for (const plan of plans) {
    log("");
    log(`${plan.slug}: ${plan.longEdge}px long edge, image_hash ${plan.hash8}`);
    for (const warning of plan.warnings) log(`  warning: ${warning}`);
    for (const object of plan.webObjects) {
      log(`  ${WEB_BUCKET_NAME}/${object.key}  ${object.width}px ${object.format}`);
    }
    log(`  ${STAGING_MASTERS_BUCKET_NAME}/${plan.stagingKey}  staging master`);
    log(`  write ${path.relative(cwd, plan.yamlPath) || plan.yamlPath}`);
    log(`  write ${path.relative(cwd, plan.placeholderPath) || plan.placeholderPath}  fallback placeholder`);
  }

  if (fatals.length > 0) {
    log("");
    for (const problem of fatals) log(`error: ${problem}`);
    return { status: 1, plans, branch, body, fatals };
  }

  if (!options.apply) {
    log("");
    log(`dry run — nothing uploaded. Re-run with --apply to publish.`);
    return { status: 0, plans, branch, body };
  }

  // Refuse a dirty tree before any bytes move: only the files this run writes
  // (plus the gitignored drop folder) may differ, so a stray edit under
  // content/photos/ or public/placeholders/ is never swept into the commit.
  const written = plans.flatMap((plan) => [
    path.relative(cwd, plan.yamlPath),
    path.relative(cwd, plan.placeholderPath),
  ]);
  const status = await exec("git", ["status", "--porcelain"], { cwd });
  const dirty = status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((file) => !written.includes(file) && !file.startsWith(`${DEFAULT_DIR}/`));
  if (dirty.length > 0) {
    log("error: the working tree has changes this run does not write:");
    for (const file of dirty) log(`  ${file}`);
    return { status: 1, plans, branch, body, fatals: dirty };
  }

  assertUploadIsSafe({
    mastersBucket: STAGING_MASTERS_BUCKET_NAME,
    webBucket: WEB_BUCKET_NAME,
  });
  requiredEnv(["R2_S3_ENDPOINT", "R2_ENDPOINT"], env);
  requiredEnv(["R2_ACCESS_KEY_ID"], env);
  requiredEnv(["R2_SECRET_ACCESS_KEY"], env);

  try {
    for (const plan of plans) {
      for (const object of plan.webObjects) {
        if (await s3.exists(WEB_BUCKET_NAME, object.key)) {
          log(`  skip (exists) ${WEB_BUCKET_NAME}/${object.key}`);
          continue;
        }
        const body = await renderDerivative(plan.bytes, {
          pixels: object.width,
          format: object.format,
        });
        await s3.put({
          bucket: WEB_BUCKET_NAME,
          key: object.key,
          body,
          contentType: object.contentType,
          cacheControl: WEB_DERIVATIVE_CACHE_CONTROL,
        });
      }
      const staging = await renderStagingMaster(plan.bytes);
      await s3.put({
        bucket: STAGING_MASTERS_BUCKET_NAME,
        key: plan.stagingKey,
        body: staging,
        contentType: "image/jpeg",
        cacheControl: STAGING_MASTER_CACHE_CONTROL,
      });
    }
  } catch (error) {
    log(`error: upload failed: ${error?.message ?? error}`);
    log("nothing was written and no PR was opened; the web keys are content-addressed, so a re-run is safe.");
    return { status: 1, plans, branch, body, fatals: [String(error?.message ?? error)] };
  }

  for (const plan of plans) {
    await mkdir(path.dirname(plan.yamlPath), { recursive: true });
    await writeFile(
      plan.yamlPath,
      renderCatalogYaml(plan.yamlText, plan.slug, plan.masterSha256, plan.hash8),
    );
    log(`  wrote ${path.relative(cwd, plan.yamlPath)}`);

    // The fallback the gallery and checkout serve with no R2 (#257). Written
    // here so every publish PR carries the one file the preview needs. A
    // --replace-image reuses the same /placeholders/{slug}.jpg URL, so a stale
    // copy can outlive the replace in a browser cache; that is only a
    // pre-cutover concern, since #245 removes the placeholder path entirely.
    await mkdir(path.dirname(plan.placeholderPath), { recursive: true });
    await writeFile(plan.placeholderPath, await renderPlaceholder(plan.bytes));
    log(`  wrote ${path.relative(cwd, plan.placeholderPath)}`);
  }

  const gitSteps = [
    ["git", ["fetch", "origin"]],
    ["git", ["checkout", "-b", branch, "origin/main"]],
    ["git", ["add", "--", CATALOG_DIR, PLACEHOLDERS_DIR]],
    ["git", ["commit", "-m", commitMessage]],
    ["git", ["push", "-u", "origin", branch]],
  ];
  for (const [command, args] of gitSteps) {
    const step = await exec(command, args, { cwd });
    if (step.status !== 0) {
      return finishByHand(log, branch, commitMessage, body, slugs, step);
    }
  }

  const pr = await exec(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      commitMessage,
      "--body",
      body,
    ],
    { cwd },
  );
  if (pr.status !== 0) {
    return finishByHand(log, branch, commitMessage, body, slugs, pr);
  }
  const prUrl = (pr.stdout.match(/https:\/\/\S+\/pull\/\d+/g) ?? []).pop() ?? "";
  log(prUrl || "PR created");
  return { status: 0, plans, branch, body, prUrl };
}

function finishByHand(log, branch, commitMessage, body, slugs, failed) {
  log(`error: ${failed.stderr.trim() || "a git/gh step failed"}`);
  log("the uploads are harmless (nothing points at them until merge). Finish by hand:");
  log(`  git fetch origin && git checkout -b ${branch} origin/main`);
  log(`  git add -- ${CATALOG_DIR} ${PLACEHOLDERS_DIR}`);
  log(`  git commit -m "${commitMessage}"`);
  log(`  git push -u origin ${branch}`);
  log(`  gh pr create --base main --head ${branch} --title "${commitMessage}" --body - <<'EOF'`);
  log(body);
  log("EOF");
  return { status: 1, branch, body, slugs };
}

/**
 * `--promote --pr <n>`: promote the masters for a PR's photos to production.
 *
 * The PR's changed `content/photos/*.yaml` (read from the PR head) is the
 * authority on what to promote; each local `ingest/{slug}.jpg` must hash to the
 * `master_sha256` it recorded, or the whole run is refused before any upload.
 * Every key is read back before auto-merge is enabled. All side effects go
 * through `deps`; returns { status }.
 */
export async function runPromote(options, deps = {}) {
  const cwd = options.cwd ?? ROOT;
  const dir = path.resolve(cwd, options.dir ?? DEFAULT_DIR);
  const log = deps.log ?? ((line) => console.log(line));
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? runCommand;
  const s3 = deps.s3 ?? createPromoteS3(env);

  const pr = options.pr;
  if (!Number.isInteger(pr) || pr <= 0) {
    log("error: --promote needs --pr <n>");
    return { status: 1, fatals: ["--promote needs --pr <n>"] };
  }

  const view = await exec(
    "gh",
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "state,baseRefName,headRefName,author,url,files",
    ],
    { cwd },
  );
  if (view.status !== 0) {
    const why = view.stderr.trim() || "gh pr view failed";
    log(`error: ${why}`);
    return { status: 1, fatals: [why] };
  }
  let pull;
  try {
    pull = JSON.parse(view.stdout);
  } catch (error) {
    log(`error: could not parse gh pr view output: ${error.message}`);
    return { status: 1, fatals: ["unparseable gh pr view output"] };
  }
  pull.number = pr;

  const who = await exec("gh", ["api", "user", "--jq", ".login"], { cwd });
  const currentUser = who.stdout.trim();
  const repo = repoFromPrUrl(pull.url);
  const { errors: prErrors, yamls } = verifyPromotePr(
    pull,
    who.status === 0 ? currentUser : undefined,
  );

  const fatals = [...prErrors];
  if (who.status !== 0) {
    fatals.push(
      `could not determine the authenticated user: ${who.stderr.trim() || "gh api user failed"}`,
    );
  }
  if (!repo) {
    fatals.push(`could not read the repo from the PR URL: ${pull.url ?? "(none)"}`);
  }

  const entries = [];
  if (repo) {
    for (const yaml of yamls) {
      const head = await readPrFile(exec, cwd, repo, yaml.path, pull.headRefName);
      if (!head.ok) {
        fatals.push(
          `could not read ${yaml.path} at ${pull.headRefName}: ${head.error}`,
        );
        continue;
      }
      let data;
      try {
        data = parseYaml(head.text);
      } catch (error) {
        fatals.push(`${yaml.path}: ${error.message}`);
        continue;
      }
      const expected =
        data && typeof data === "object" ? data.master_sha256 : undefined;
      if (typeof expected !== "string" || !MASTER_SHA256_PATTERN.test(expected)) {
        fatals.push(
          `${yaml.path}: master_sha256 is missing or malformed; ` +
            `run publish-photos --apply first`,
        );
        continue;
      }

      // A replacement must be a genuinely new master, not a caption-only edit:
      // compare the head hash against the base branch's. An unreadable base is
      // treated as not-a-replacement, which refuses rather than overwrites.
      let baseMasterSha256;
      if (yaml.changeType === "MODIFIED") {
        const base = await readPrFile(exec, cwd, repo, yaml.path, pull.baseRefName);
        if (base.ok) {
          try {
            baseMasterSha256 = parseYaml(base.text)?.master_sha256;
          } catch {
            baseMasterSha256 = undefined;
          }
        }
      }

      const jpeg = path.join(dir, `${yaml.slug}.jpg`);
      let bytes;
      try {
        bytes = await readFile(jpeg);
      } catch {
        fatals.push(`missing ${path.relative(cwd, jpeg) || jpeg}`);
        continue;
      }
      const actual = await sha256Hex(bytes);
      if (actual !== expected) {
        fatals.push(
          `${path.relative(cwd, jpeg) || jpeg} is not the file that was previewed`,
        );
        continue;
      }
      entries.push({
        slug: yaml.slug,
        key: masterKeyFromSlug(yaml.slug),
        masterSha256: expected,
        length: bytes.length,
        bytes,
        isReplace: isReplacement({
          changeType: yaml.changeType,
          baseMasterSha256,
          headMasterSha256: expected,
        }),
      });
    }
  }

  if (fatals.length === 0 && entries.length === 0) {
    fatals.push(`PR #${pr} has no promotable photos`);
  }
  if (fatals.length > 0) {
    log("");
    for (const problem of fatals) log(`error: ${problem}`);
    if (entries.length > 0) log(`refused before any upload (${entries.length} photo(s) were ready).`);
    else log("nothing was uploaded and auto-merge was not enabled.");
    return { status: 1, fatals };
  }

  requiredEnv(["R2_S3_ENDPOINT", "R2_ENDPOINT"], env);
  requiredEnv(["R2_ACCESS_KEY_ID"], env);
  requiredEnv(["R2_SECRET_ACCESS_KEY"], env);

  // Preflight every key before a byte moves: a batch is never half-written.
  let actions;
  try {
    actions = [];
    for (const entry of entries) {
      const existing = await s3.head(MASTERS_BUCKET_NAME, entry.key);
      const plan = planPromoteAction({
        existing,
        masterSha256: entry.masterSha256,
        isReplace: entry.isReplace,
      });
      actions.push({ ...entry, ...plan });
    }
  } catch (error) {
    log(`error: ${error?.message ?? error}`);
    return { status: 1, fatals: [String(error?.message ?? error)] };
  }
  const refused = actions.filter((action) => action.action === "refuse");
  if (refused.length > 0) {
    log("");
    for (const action of refused) {
      log(`error: ${MASTERS_BUCKET_NAME}/${action.key} ${action.reason}`);
    }
    log("nothing was uploaded and auto-merge was not enabled.");
    return { status: 1, fatals: refused.map((a) => `${a.key}: ${a.reason}`) };
  }

  try {
    for (const action of actions) {
      log("");
      log(`${action.slug}: master_sha256 ${action.masterSha256.slice(0, 8)}`);
      log(`  ${MASTERS_BUCKET_NAME}/${action.key}  ${action.action}`);
      if (action.action === "skip") {
        log("  skip (already holds this master)");
        continue;
      }
      await s3.put({
        bucket: MASTERS_BUCKET_NAME,
        key: action.key,
        body: action.bytes,
        contentType: "image/jpeg",
        cacheControl: PROMOTE_MASTER_CACHE_CONTROL,
        metadata: { [MASTER_METADATA_KEY]: action.masterSha256 },
      });
      if (action.action === "replace") {
        log("  replacement: past buyers' downloads now get the new file");
      }
    }
  } catch (error) {
    log(`error: upload failed: ${error?.message ?? error}`);
    log("auto-merge was not enabled; inspect the bucket before re-running.");
    return {
      status: 1,
      fatals: [String(error?.message ?? error)],
    };
  }

  // Read back every key: the sha256 metadata and byte length must match the
  // local file before the PR is allowed to merge. A read-back that throws is
  // treated as a mismatch rather than escaping with a stack trace.
  const mismatches = [];
  for (const action of actions) {
    let head;
    try {
      head = await s3.head(MASTERS_BUCKET_NAME, action.key);
    } catch (error) {
      mismatches.push(`${action.key}: read-back failed: ${error?.message ?? error}`);
      continue;
    }
    const stored = metadataValue(head?.metadata, MASTER_METADATA_KEY);
    if (stored !== action.masterSha256 || head?.contentLength !== action.length) {
      mismatches.push(
        `${action.key}: read-back ${stored ?? "unset"} / ` +
          `${head?.contentLength ?? "?"} bytes does not match ` +
          `${action.masterSha256} / ${action.length} bytes`,
      );
    }
  }
  if (mismatches.length > 0) {
    log("");
    for (const problem of mismatches) log(`error: ${problem}`);
    log("auto-merge was not enabled; inspect the bucket before re-running.");
    return { status: 1, fatals: mismatches };
  }

  const merge = await exec("gh", ["pr", "merge", String(pr), "--auto", "--squash"], {
    cwd,
  });
  if (merge.status !== 0) {
    const why = merge.stderr.trim() || "gh pr merge failed";
    log(`error: ${why}`);
    return { status: 1, fatals: [why] };
  }
  log("");
  log(`PR #${pr} will auto-merge (squash) once the required checks pass.`);
  log("The release then deploys staging → smoke tests → master check → production.");
  return { status: 0, pr, actions };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    process.loadEnvFile(path.join(ROOT, ".env.local"));
  } catch {
    // No .env.local is fine; the values may be exported in the shell.
  }
  const result = options.audit
    ? await runAudit({ cwd: ROOT, json: options.json })
    : options.promote
      ? await runPromote({ ...options, cwd: ROOT })
      : await runPublish({ ...options, cwd: ROOT });
  if (result.status !== 0) process.exitCode = result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`publish-photos failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

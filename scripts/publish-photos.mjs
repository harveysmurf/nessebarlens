#!/usr/bin/env node
/**
 * Publish dropped photos end to end: validate a `{slug}.jpg` + `{slug}.yaml`
 * pair, upload the public web ladder (#240) and the staging master (#212),
 * write the catalog YAML, and open one PR for the run.
 *
 *   npm run publish-photos                       # dry run: validate + print the plan
 *   npm run publish-photos -- --apply            # upload, write YAML, open PR
 *   npm run publish-photos -- --apply --only dawn,dusk
 *   npm run publish-photos -- --apply --replace-image dawn
 *
 * Drop folder defaults to the gitignored `ingest/`; `--dir <path>` overrides.
 * Input is one JPEG and one YAML per slug. The production masters bucket is
 * never written here — that is `--promote` (#242): this command's uploader has
 * no client for it, and `assertUploadIsSafe` names the two buckets it may use.
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
  renderStagingMaster,
} from "./derivative-image.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DEFAULT_DIR = "ingest";
const CATALOG_DIR = "content/photos";
const GENERATED_KEYS = ["master_sha256", "image_hash"];
/** A re-ingest overwrites the staging master's same key; a week is enough. */
const STAGING_MASTER_CACHE_CONTROL = "public, max-age=604800";
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
  return {
    apply: has("--apply"),
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
    "",
    `Next: \`npm run publish-photos -- --promote --pr <n>\` (after this PR merges; see #242).`,
    "",
    `_Generated ${branchDate}._`,
  );
  return lines.join("\n");
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

  // Refuse a dirty tree before any bytes move: only content/photos/ may differ.
  const status = await exec("git", ["status", "--porcelain"], { cwd });
  const dirty = status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith(`${CATALOG_DIR}/`) && !file.startsWith(`${DEFAULT_DIR}/`));
  if (dirty.length > 0) {
    log(`error: the working tree has changes outside ${CATALOG_DIR}/:`);
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
  }

  const gitSteps = [
    ["git", ["fetch", "origin"]],
    ["git", ["checkout", "-b", branch, "origin/main"]],
    ["git", ["add", "--", CATALOG_DIR]],
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
  log(`  git add -- ${CATALOG_DIR}`);
  log(`  git commit -m "${commitMessage}"`);
  log(`  git push -u origin ${branch}`);
  log(`  gh pr create --base main --head ${branch} --title "${commitMessage}" --body - <<'EOF'`);
  log(body);
  log("EOF");
  return { status: 1, branch, body, slugs };
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
  const result = await runPublish({ ...options, cwd: ROOT });
  if (result.status !== 0) process.exitCode = result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`publish-photos failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

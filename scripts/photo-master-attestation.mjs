#!/usr/bin/env node
/**
 * Trusted PR-side attestation for production photo assets.
 *
 * This script runs only from the base branch in the pull_request_target
 * workflow. It reads changed catalog YAML through GitHub's API as data; it
 * never checks out or executes the pull request head. Published photo changes
 * stay unverified until the guarded local `publish-photos --promote` command has
 * written matching production masters and print assets.
 *
 * The check is advisory (#404). The authoritative guarantee is
 * `release.yml`'s `Verify production masters` job, which runs before staging and
 * before production, so a photo merged without `--promote` leaves `main`
 * undeployable rather than serving a catalog that lists a photo it cannot
 * deliver. This workflow saves someone finding that out in a release log.
 *
 * Two modes, and the split is deliberate. `inspect` parses untrusted PR YAML and
 * so runs with no bucket credentials; `verify` holds the read-only R2 secrets and
 * re-derives the selection itself rather than trusting a value passed between
 * steps, so there is no path by which a value chosen by untrusted YAML reaches a
 * step that can read the bucket. The selection is a handful of API calls, which
 * is what makes recomputing it free.
 */

import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { validatePhotoFile } from "../src/domain/catalog/photo-schema";

const CATALOG_PATH = /^content\/photos\/([^/]+)\.ya?ml$/;
const API_BASE = "https://api.github.com";
const WAIT_INTERVAL_MS = 30_000;
const WAIT_TIMEOUT_MS = 55 * 60_000;

/** @typedef {{path?: string, filename?: string, previous_filename?: string, status?: string}} PullFile */

/**
 * The changed catalog YAML in a PR, with the path it had at base when there is
 * one. `previousPath` is what makes a rename distinguishable from a new file:
 * a file renamed into `content/photos/` has no base catalog entry under that
 * path, so it counts as new, while a rename within the directory is a rename.
 * @param {PullFile[]} files
 */
export function changedPhotoYamlFiles(files) {
  /** @type {{path: string, previousPath?: string}[]} */
  const out = [];
  for (const file of files) {
    const filePath = file.filename ?? file.path ?? "";
    if (!CATALOG_PATH.test(filePath)) continue;
    if (file.status?.toLowerCase() === "removed") continue;
    const previous = file.previous_filename;
    out.push({
      path: filePath,
      ...(typeof previous === "string" && previous !== filePath && CATALOG_PATH.test(previous)
        ? { previousPath: previous }
        : {}),
    });
  }
  return out;
}

/**
 * Parses and validates one changed catalog entry. `undefined` means the entry
 * is intentionally unpublished, so it does not need production objects.
 * @param {string} filePath
 * @param {string} yamlText
 */
export function publishedPhotoFromYaml(filePath, yamlText) {
  const match = CATALOG_PATH.exec(filePath);
  if (!match) throw new Error(`${filePath}: not a photo catalog YAML path`);
  const slug = match[1];
  const data = parseYaml(yamlText);
  const validation = validatePhotoFile(slug, data);
  if (!validation.ok) {
    throw new Error(
      `${filePath}: ${validation.problems.join("; ")}`,
    );
  }
  if (!validation.photo.published) return undefined;
  return {
    slug: validation.photo.slug,
    published: true,
    masterSha256: validation.photo.masterSha256,
    printAsset: validation.photo.printAsset,
  };
}

/**
 * Why one listing needs production objects, or `null` when it does not.
 *
 * One function rather than a boolean plus a log formatter, because the two
 * would have to agree about when a change needs assets and a pair that can
 * disagree is how a photo gets skipped. Pure: both sides are the
 * `publishedPhotoFromYaml` result, or `undefined`.
 *
 * `renamed` is the one thing not visible in the two entries — the slug is the
 * filename, so a rename within the directory shows up as a changed slug, which
 * is why it is passed rather than inferred.
 * @param {ReturnType<typeof publishedPhotoFromYaml>} base
 * @param {ReturnType<typeof publishedPhotoFromYaml>} head
 * @param {{renamed?: boolean}} [context]
 */
export function photoAssetChange(base, head, { renamed = false } = {}) {
  // An unpublished or absent head needs nothing. Deletions never reach here:
  // `changedPhotoYamlFiles` drops them, and an unpublished entry is the
  // deliberate "this photo is not offered" case.
  if (!head?.published) return null;
  if (!base) return { needs: true, reason: renamed ? "renamed" : "new listing" };
  if (base.slug !== head.slug) return { needs: true, reason: "renamed" };
  if (base.masterSha256 !== head.masterSha256) {
    return { needs: true, reason: "master changed" };
  }
  if (base.printAsset?.sha256 !== head.printAsset?.sha256) {
    return { needs: true, reason: "print asset changed" };
  }
  // Title, description, print options: the catalog's text moved, the objects
  // the bucket must hold did not.
  return null;
}

/**
 * Whether this PR needs the production bucket read for one listing. The
 * decision, with the reason split out for the log line.
 * @param {ReturnType<typeof publishedPhotoFromYaml>} base
 * @param {ReturnType<typeof publishedPhotoFromYaml>} head
 */
export function photoNeedsAssets(base, head) {
  return photoAssetChange(base, head) !== null;
}

/** @param {string} name */
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

/** @param {string} repo @param {number} number @param {string} token */
function apiUrl(repo, number, token) {
  return {
    repo,
    number,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  };
}

/** @param {string} repo @param {number} number @param {string} token @param {typeof fetch} fetchImpl */
async function readPullRequest(repo, number, token, fetchImpl) {
  const request = apiUrl(repo, number, token);
  const response = await fetchImpl(
    `${API_BASE}/repos/${request.repo}/pulls/${request.number}`,
    { headers: request.headers },
  );
  if (!response.ok) {
    throw new Error(`GitHub could not read PR #${number} (${response.status})`);
  }
  return response.json();
}

/** @param {string} repo @param {number} number @param {string} token @param {typeof fetch} fetchImpl */
async function readPullFiles(repo, number, token, fetchImpl) {
  const request = apiUrl(repo, number, token);
  const files = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `${API_BASE}/repos/${request.repo}/pulls/${request.number}/files?per_page=100&page=${page}`,
      { headers: request.headers },
    );
    if (!response.ok) {
      throw new Error(`GitHub could not list PR #${number} files (${response.status})`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub returned an invalid file list for PR #${number}`);
    }
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

/**
 * A file's text at one ref, or `undefined` when it is not there. The 404 is an
 * answer, not a failure: a photo that exists at head and not at base is a new
 * listing, which is the common case for exactly the PRs this workflow exists
 * for. Any other non-OK response still throws.
 * @param {string} repo @param {string} filePath @param {string} sha @param {string} token @param {typeof fetch} fetchImpl
 */
async function readFileAt(repo, filePath, sha, token, fetchImpl) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetchImpl(
    `${API_BASE}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub could not read ${filePath} at ${sha} (${response.status})`);
  }
  const file = await response.json();
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error(`GitHub returned unsupported content for ${filePath}`);
  }
  return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
}

/**
 * One listing read at one ref.
 *
 * `strict` is the head/base asymmetry, and it is the point: invalid head YAML is
 * this PR's own doing and fails the job, while an unreadable or invalid *base*
 * entry is not something this PR can fix, and treating it as "needs assets" is
 * the direction that keeps a photo from shipping unverified.
 * @param {string} repo @param {string} filePath @param {string} sha @param {string} token @param {typeof fetch} fetchImpl @param {{strict: boolean}} options
 */
async function photoAtRef(repo, filePath, sha, token, fetchImpl, { strict }) {
  const yamlText = await readFileAt(repo, filePath, sha, token, fetchImpl);
  if (yamlText === undefined) return undefined;
  try {
    return publishedPhotoFromYaml(filePath, yamlText);
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
}

/**
 * The changed listings that need production objects, read at one exact PR head
 * against the base the run checked out. The caller treats a stale workflow event
 * as a failure; a synchronize event starts a fresh attestation for the new SHA.
 * @param {{repo: string, number: number, headSha: string, baseSha: string, token: string, fetchImpl?: typeof fetch}} options
 */
export async function readPhotosNeedingAssets({
  repo,
  number,
  headSha,
  baseSha,
  token,
  fetchImpl = fetch,
}) {
  const pull = await readPullRequest(repo, number, token, fetchImpl);
  if (pull.head?.sha !== headSha) {
    throw new Error(`PR #${number} changed while its photo assets were being checked`);
  }
  const files = await readPullFiles(repo, number, token, fetchImpl);
  /** @type {{photo: NonNullable<ReturnType<typeof publishedPhotoFromYaml>>, reason: string}[]} */
  const needing = [];
  for (const { path, previousPath } of changedPhotoYamlFiles(files)) {
    const head = await photoAtRef(repo, path, headSha, token, fetchImpl, { strict: true });
    if (!head) continue;
    const base = await photoAtRef(
      repo,
      previousPath ?? path,
      baseSha,
      token,
      fetchImpl,
      { strict: false },
    );
    const change = photoAssetChange(base, head, { renamed: previousPath !== undefined });
    if (change) needing.push({ photo: head, reason: change.reason });
  }
  return needing;
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Waits for the guarded promoter to finish writing all changed photo assets.
 * Missing or mismatched objects can resolve while promotion is in progress;
 * invalid catalog data and read failures are terminal.
 */
export async function waitForPhotoMasters({
  photos,
  s3,
  timeoutMs = WAIT_TIMEOUT_MS,
  intervalMs = WAIT_INTERVAL_MS,
  now = Date.now,
  sleepImpl = sleep,
  log = () => {},
}) {
  const deadline = now() + timeoutMs;
  let failures = [];
  while (true) {
    failures = await verifyPhotos(photos, s3);
    if (failures.length === 0) return { ok: true, failures: [] };

    const terminal = failures.filter((failure) =>
      /no master_sha256|no print asset in the catalog|head failed/.test(failure),
    );
    if (terminal.length > 0) return { ok: false, failures: terminal };

    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, failures };
    log(`waiting for ${failures.length} production photo object check(s)`);
    await sleepImpl(Math.min(intervalMs, remaining));
  }
}

/** @param {unknown[]} photos @param {unknown} s3 */
async function verifyPhotos(photos, s3) {
  const { verifyMasters } = await import("./verify-masters.mjs");
  return verifyMasters({ photos, s3 });
}

/** @param {string} mode */
async function main(mode) {
  const repo = requiredEnv("GITHUB_REPOSITORY");
  const number = Number(requiredEnv("PR_NUMBER"));
  const headSha = requiredEnv("HEAD_SHA");
  const baseSha = requiredEnv("BASE_SHA");
  const token = requiredEnv("GH_TOKEN");

  if (mode !== "inspect" && mode !== "verify") {
    throw new Error("usage: photo-master-attestation.mjs <inspect|verify>");
  }

  // Re-derived in both modes rather than passed between them: the step that
  // holds the bucket credentials must not act on a decision a step without them
  // made. It is a few API calls.
  const needing = await readPhotosNeedingAssets({ repo, number, headSha, baseSha, token });

  if (mode === "inspect") {
    await appendFile(requiredEnv("GITHUB_OUTPUT"), `needs-assets=${needing.length > 0}\n`);
    if (needing.length === 0) {
      console.log(
        "no changed listing adds, renames, newly publishes or re-hashes a published photo; no production read needed",
      );
      return;
    }
    for (const { photo, reason } of needing) {
      console.log(`${photo.slug}: needs production assets (${reason})`);
    }
    console.log(`production read needed for ${needing.length} photo(s)`);
    return;
  }

  if (needing.length === 0) {
    console.log(
      "no changed listing adds, renames, newly publishes or re-hashes a published photo; no production read needed",
    );
    return;
  }
  const { createMastersS3 } = await import("./verify-masters.mjs");
  const photos = needing.map(({ photo }) => photo);
  const result = await waitForPhotoMasters({ photos, s3: createMastersS3(process.env) });
  if (!result.ok) {
    throw new Error(
      `production photo assets did not match the PR catalog before timeout: ${result.failures.join("; ")}`,
    );
  }
  console.log(`verified production master and print asset for ${photos.length} photo(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "").catch((error) => {
    console.error(`photo-master-attestation: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

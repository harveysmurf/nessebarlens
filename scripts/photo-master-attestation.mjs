#!/usr/bin/env node
/**
 * Trusted PR-side attestation for production photo assets.
 *
 * This script runs only from the base branch in the pull_request_target
 * workflow. It reads changed catalog YAML through GitHub's API as data; it
 * never checks out or executes the pull request head. Published photo changes
 * stay pending until the guarded local `publish-photos --promote` command has
 * written matching production masters and print assets.
 */

import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { validatePhotoFile } from "../src/domain/catalog/photo-schema";

export const PHOTO_MASTER_STATUS_CONTEXT = "Photo master promotion";
const CATALOG_PATH = /^content\/photos\/([^/]+)\.ya?ml$/;
const API_BASE = "https://api.github.com";
const WAIT_INTERVAL_MS = 30_000;
const WAIT_TIMEOUT_MS = 55 * 60_000;

/** @typedef {{path?: string, filename?: string, status?: string}} PullFile */

/** @param {PullFile[]} files */
export function changedPhotoYamlFiles(files) {
  return files
    .filter((file) => {
      const filePath = file.filename ?? file.path ?? "";
      const status = file.status?.toLowerCase();
      return CATALOG_PATH.test(filePath) && status !== "removed";
    })
    .map((file) => file.filename ?? file.path)
    .filter((filePath) => typeof filePath === "string");
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

/** @param {string} repo @param {string} filePath @param {string} sha @param {string} token @param {typeof fetch} fetchImpl */
async function readFileAtHead(repo, filePath, sha, token, fetchImpl) {
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
  if (!response.ok) {
    throw new Error(`GitHub could not read ${filePath} at the PR head (${response.status})`);
  }
  const file = await response.json();
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error(`GitHub returned unsupported content for ${filePath}`);
  }
  return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
}

/**
 * Returns the changed, published photo entries from one exact PR head. The
 * caller treats a stale workflow event as a failure; a synchronize event starts
 * a fresh attestation for the new SHA.
 */
export async function readChangedPublishedPhotos({
  repo,
  number,
  headSha,
  token,
  fetchImpl = fetch,
}) {
  const pull = await readPullRequest(repo, number, token, fetchImpl);
  if (pull.head?.sha !== headSha) {
    throw new Error(`PR #${number} changed while its photo assets were being checked`);
  }
  const files = await readPullFiles(repo, number, token, fetchImpl);
  const paths = changedPhotoYamlFiles(files);
  const photos = [];
  for (const filePath of paths) {
    const yamlText = await readFileAtHead(
      repo,
      filePath,
      headSha,
      token,
      fetchImpl,
    );
    const photo = publishedPhotoFromYaml(filePath, yamlText);
    if (photo) photos.push(photo);
  }
  return photos;
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

/** @param {string} state @param {{repo: string, sha: string, token: string, runUrl: string, fetchImpl?: typeof fetch}} options */
export async function postPhotoMasterStatus(state, {
  repo,
  sha,
  token,
  runUrl,
  fetchImpl = fetch,
}) {
  if (!["pending", "success", "failure", "error"].includes(state)) {
    throw new Error(`invalid commit status state: ${state}`);
  }
  const response = await fetchImpl(`${API_BASE}/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      state,
      context: PHOTO_MASTER_STATUS_CONTEXT,
      description:
        state === "success"
          ? "Changed published photo assets match production masters."
          : state === "pending"
            ? "Waiting for changed photo assets to be promoted."
            : "Production photo assets did not pass verification.",
      target_url: runUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub could not post photo master status (${response.status})`);
  }
}

/** @param {{inspectResult: string, hasPublishedPhotos: string, verifyResult: string}} results */
export function finalStatusState({ inspectResult, hasPublishedPhotos, verifyResult }) {
  if (inspectResult !== "success") return "failure";
  if (hasPublishedPhotos !== "true") return "success";
  return verifyResult === "success" ? "success" : "failure";
}

/** @param {string} mode */
async function main(mode) {
  const repo = requiredEnv("GITHUB_REPOSITORY");
  const number = Number(requiredEnv("PR_NUMBER"));
  const headSha = requiredEnv("HEAD_SHA");
  const token = requiredEnv("GH_TOKEN");
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`;

  if (mode === "pending" || mode === "success" || mode === "failure") {
    await postPhotoMasterStatus(mode, { repo, sha: headSha, token, runUrl });
    return;
  }

  const photos = await readChangedPublishedPhotos({ repo, number, headSha, token });
  if (mode === "inspect") {
    const output = requiredEnv("GITHUB_OUTPUT");
    await appendFile(output, `has-published-photos=${photos.length > 0}\n`);
    console.log(
      photos.length > 0
        ? `photo-master gate required for ${photos.length} published photo(s)`
        : "no changed published photo entries require production verification",
    );
    return;
  }
  if (mode === "verify") {
    if (photos.length === 0) {
      console.log("no changed published photo entries require production verification");
      return;
    }
    const { createMastersS3 } = await import("./verify-masters.mjs");
    const result = await waitForPhotoMasters({ photos, s3: createMastersS3(process.env) });
    if (!result.ok) {
      throw new Error(
        `production photo assets did not match the PR catalog before timeout: ${result.failures.join("; ")}`,
      );
    }
    console.log(`verified production master and print asset for ${photos.length} photo(s)`);
    return;
  }
  if (mode === "report") {
    const state = finalStatusState({
      inspectResult: requiredEnv("INSPECT_RESULT"),
      hasPublishedPhotos: requiredEnv("HAS_PUBLISHED_PHOTOS"),
      verifyResult: requiredEnv("VERIFY_RESULT"),
    });
    await postPhotoMasterStatus(state, { repo, sha: headSha, token, runUrl });
    return;
  }
  throw new Error("usage: photo-master-attestation.mjs <pending|inspect|verify|report>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "").catch((error) => {
    console.error(`photo-master-attestation: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

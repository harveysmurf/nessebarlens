#!/usr/bin/env node
/**
 * npm run publish-photos — a launcher, not the work.
 *
 * Its only job is the Node version check, and it is a separate file for a
 * concrete reason: ES module imports are hoisted, so a check at the top of
 * publish-photos.mjs would run *after* that file had already imported sharp /
 * the ladder. Under Node 20 that import throws ERR_UNKNOWN_FILE_EXTENSION
 * before a single line of the script's own body executes, and the operator
 * gets a stack trace about a loader instead of "install Node 24.21". Here the
 * check runs first, in a file with no imports of ours, so the message is the
 * one the reader needs.
 *
 * The spawn passes `--import ./scripts/register.mjs` because publish-photos
 * imports src/domain/catalog/photo-schema.ts, whose own imports are extensionless. The
 * version check above is what makes that safe on an old Node.
 *
 * The run is behind an `isMain` guard, the convention every other ops script
 * in this directory follows, so a test can import this file and drive the two
 * decisions it makes — the version check and the child's argv — instead of
 * reading its source text. Without the guard the coverage gate cannot measure
 * this file at all: node's report lists loaded modules only, and nothing loads
 * a launcher.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");

/** The repo's pin, read rather than repeated — three copies drift (see §3). */
export const PINNED_NODE = readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();

/**
 * The message the operator gets when the running node is not the pinned one,
 * or null when it is.
 *
 * The rule is the pin's: the same major, and the minor at least as high. The
 * patch line does not matter — sharp is compiled per Node *line*, not per
 * patch.
 */
export function nodeVersionError(pinned, running) {
  const [reqMajor, reqMinor] = pinned.split(".").map(Number);
  const [major, minor] = running.split(".").map(Number);
  if (major === reqMajor && (minor ?? 0) >= reqMinor) return null;
  return (
    `publish-photos needs Node ${pinned} (this is ${running}).\n` +
    `sharp is a native binding compiled per Node line, so a mismatch fails ` +
    `with an opaque loader error rather than anything about images.\n` +
    `Fix: nvm use   (or install Node ${pinned} and re-run)\n`
  );
}

/** The argv the uploader is spawned with. */
export function publishPhotosArgv(argv) {
  return [
    "--import",
    "./scripts/register.mjs",
    path.join(import.meta.dirname, "publish-photos.mjs"),
    ...argv,
  ];
}

/**
 * Run the uploader, or refuse to. Returns the exit code the caller should
 * exit with; the refusal is written to stderr here, because the operator is
 * the one who has to act on it.
 */
export function run(argv = process.argv.slice(2)) {
  const error = nodeVersionError(PINNED_NODE, process.versions.node);
  if (error) {
    process.stderr.write(error);
    return 1;
  }
  const result = spawnSync(process.execPath, publishPhotosArgv(argv), {
    stdio: "inherit",
    cwd: ROOT,
  });
  return result.status ?? 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(run());
}

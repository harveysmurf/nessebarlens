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
 * imports src/lib/photo-schema.ts, whose own imports are extensionless. The
 * version check above is what makes that safe on an old Node.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.join(import.meta.dirname, "..");

/** The repo's pin, read rather than repeated — three copies drift (see §3). */
const PINNED = readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();

const [reqMajor, reqMinor] = PINNED.split(".").map(Number);
const [major, minor] = process.versions.node.split(".").map(Number);

if (major !== reqMajor || (minor ?? 0) < reqMinor) {
  process.stderr.write(
    `publish-photos needs Node ${PINNED} (this is ${process.versions.node}).\n` +
      `sharp is a native binding compiled per Node line, so a mismatch fails ` +
      `with an opaque loader error rather than anything about images.\n` +
      `Fix: nvm use   (or install Node ${PINNED} and re-run)\n`,
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/register.mjs",
    path.join(import.meta.dirname, "publish-photos.mjs"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", cwd: ROOT },
);
process.exit(result.status ?? 1);

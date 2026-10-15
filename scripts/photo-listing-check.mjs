#!/usr/bin/env node
/**
 * #406: does this pull request change what production lists, or which bucket
 * objects those listings need, without touching `content/photos/*.yaml`?
 *
 * Since #404 the PR-time photo check is path-filtered to `content/photos/*.y{a,}ml`,
 * so a pull request that changes the *code* behind a listing gets no PR-time
 * signal at all. A schema default moving, or the bucket key derivation in
 * `src/domain/catalog/derivative-ladder.ts` changing, alters production listings
 * exactly as much as editing the YAML does -- and the YAML-only attestation
 * never runs. The failure surfaces later, in `release.yml`'s `Verify production
 * masters`, with `main` already undeployable.
 *
 * This is the missing half, and it is deliberately the cheap half. It reads no
 * bucket: it compares the *listing set* of base and head and reports when the
 * two differ. A difference is not proof that an asset is missing -- the release
 * gate remains the enforcement -- it is the PR-time signal that the release gate
 * is about to refuse, said while the change is still reviewable.
 *
 * Both sides are built from source rather than compared as YAML, because the
 * code is half of what is being compared:
 *
 *   base  the base tree, built by *its own* validator and *its own* key
 *         derivation, so a schema or ladder change is exactly what moves the set
 *   head  the pull request's own tree, built the same way
 *
 * The head side runs pull-request code, which is why this is a `pull_request`
 * job holding no secrets and no `environment:` -- the same rule that keeps the
 * attestation on `pull_request_target`. tests/photo-listing-check.test.mts pins
 * that, and pins the job's absence of a `paths:` filter, because a required
 * check that can be skipped is the #404 failure mode pointed the other way.
 *
 * The extraction and the diff below are pure and take the two built listings as
 * arguments, so the interesting half is unit-tested without a checkout, a git
 * worktree, or a runner. `main()` is only plumbing: worktree, two builds, verdict.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Deliberately no `src/` import here. `masterKeyFromSlug` /
// `printAssetKeyFromSlug` belong to the *tree being built*, and the two sides of
// the comparison are two different trees -- see `listingSet`, which takes them as
// arguments. Importing this file's own copy at module scope would price every
// listing with head's key derivation, and the base side would report no key
// change for a PR whose entire subject is one.
const PHOTOS_DIR = "content/photos";
const WORKTREE_DIR = ".listing-base";
const SCRATCH_DIR = ".listing-check";
const ACK_LABEL = "photo-listing-ack";

/**
 * @typedef {object} KeyDerivation
 * @property {(slug: string) => string} masterKeyFromSlug
 * @property {(slug: string) => string} printAssetKeyFromSlug
 */

/**
 * @typedef {object} ListingEntry
 * @property {string} slug
 * @property {string | null} masterSha256
 * @property {string | null} printAssetSha256
 * @property {string} masterKey
 * @property {string} printAssetKey
 */

/**
 * @typedef {object} ListingChange
 * @property {"added"|"removed"|"renamed"|"rehashed"|"keys-changed"} kind
 * @property {string} slug          the head slug, or the base slug for a removal
 * @property {string} [from]        the previous slug, for a rename
 * @property {string[]} fields      what moved, for rehashed / keys-changed
 * @property {string} detail        one line for the failure message
 */

/**
 * What production has to serve for one published photo: the listing itself and
 * the two bucket objects behind it.
 *
 * The key derivation is a parameter rather than an import, and that is the whole
 * reason this check can catch a key-derivation change at all. Both sides of the
 * comparison run the *same* extraction, so the only thing left that can differ
 * between a base key and a head key is the ladder that produced it -- which is
 * exactly the edit under test. An import at this file's module scope would tie
 * both sides to head's ladder and report no change for a PR that renames the
 * bucket prefix.
 *
 * Pure, and it takes the built photos rather than the filesystem, so the same
 * shape is produced for base and head and the diff below never touches disk.
 * @param {{slug: string, published?: boolean, masterSha256?: string, printAsset?: {sha256: string} | undefined}[]} photos
 * @param {KeyDerivation} keys
 * @returns {ListingEntry[]}
 */
export function listingSet(photos, { masterKeyFromSlug, printAssetKeyFromSlug }) {
  return photos
    .filter((photo) => photo.published === true)
    .map((photo) => ({
      slug: photo.slug,
      masterSha256: photo.masterSha256 ?? null,
      printAssetSha256: photo.printAsset?.sha256 ?? null,
      masterKey: masterKeyFromSlug(photo.slug),
      printAssetKey: printAssetKeyFromSlug(photo.slug),
    }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * How the head listing set differs from base. Sorted by slug so the failure
 * message and the tests see the same order every time.
 *
 * Renames are the one thing the two sets do not spell out: the slug is the YAML
 * filename, so a rename inside `content/photos/` arrives as one removal and one
 * addition and nothing says they are the same photo. They are paired on the
 * master hash -- the same bytes under a new name -- which is the one thing that
 * survives a rename. It only changes how the failure reads, never whether it
 * fires: an unpaired removal and addition are reported as themselves.
 * @param {ListingEntry[]} base
 * @param {ListingEntry[]} head
 * @returns {{changed: boolean, changes: ListingChange[]}}
 */
export function diffListingSets(base, head) {
  const baseBySlug = new Map(base.map((entry) => [entry.slug, entry]));
  const headBySlug = new Map(head.map((entry) => [entry.slug, entry]));

  /** @type {ListingChange[]} */
  const changes = [];
  /** @type {Set<string>} */
  const renamedFrom = new Set();
  /** @type {Set<string>} */
  const renamedTo = new Set();

  const removed = base.filter((entry) => !headBySlug.has(entry.slug));
  const added = head.filter((entry) => !baseBySlug.has(entry.slug));

  for (const entry of added) {
    const twin = removed.find(
      (candidate) =>
        !renamedFrom.has(candidate.slug) &&
        candidate.masterSha256 !== null &&
        candidate.masterSha256 === entry.masterSha256,
    );
    if (!twin) continue;
    renamedFrom.add(twin.slug);
    renamedTo.add(entry.slug);
    changes.push({
      kind: "renamed",
      slug: entry.slug,
      from: twin.slug,
      fields: [],
      detail: `renamed ${twin.slug} -> ${entry.slug}`,
    });
  }

  for (const entry of added) {
    if (renamedTo.has(entry.slug)) continue;
    changes.push({
      kind: "added",
      slug: entry.slug,
      fields: [],
      detail: `newly listed: ${entry.slug}`,
    });
  }

  for (const entry of removed) {
    if (renamedFrom.has(entry.slug)) continue;
    changes.push({
      kind: "removed",
      slug: entry.slug,
      fields: [],
      detail: `no longer listed: ${entry.slug}`,
    });
  }

  for (const entry of head) {
    const before = baseBySlug.get(entry.slug);
    if (!before) continue;

    /** @type {string[]} */
    const hashes = [];
    if (before.masterSha256 !== entry.masterSha256) hashes.push("master sha256");
    if (before.printAssetSha256 !== entry.printAssetSha256) {
      hashes.push("print asset sha256");
    }
    if (hashes.length > 0) {
      changes.push({
        kind: "rehashed",
        slug: entry.slug,
        fields: hashes,
        detail: `${entry.slug}: ${hashes.join(" and ")} changed`,
      });
    }

    /** @type {string[]} */
    const keys = [];
    if (before.masterKey !== entry.masterKey) keys.push("master key");
    if (before.printAssetKey !== entry.printAssetKey) keys.push("print asset key");
    if (keys.length > 0) {
      changes.push({
        kind: "keys-changed",
        slug: entry.slug,
        fields: keys,
        detail: `${entry.slug}: ${keys.join(" and ")} changed`,
      });
    }
  }

  changes.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { changed: changes.length > 0, changes };
}

/**
 * One string that changes iff any catalog YAML differs between two trees.
 *
 * The question the check has to answer about the PR is "did it touch photo
 * YAML?", and comparing the two trees already on disk answers it exactly -- no
 * API call, no token, no fork-PR caveat, and the same answer whether the PR
 * renamed a file or edited one. Returns `""` for a directory that is not there,
 * so an empty base is a difference rather than a crash.
 * @param {string} photosDir
 */
export function photoYamlFingerprint(photosDir) {
  if (!existsSync(photosDir)) return "";
  return readdirSync(photosDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => `${name}:${createHash("sha256").update(readFileSync(path.join(photosDir, name))).digest("hex")}`)
    .join("\n");
}

/**
 * @typedef {"clean"|"logged"|"acknowledged"|"failed"} Verdict
 */

/**
 * What the run should report, given the difference and how the PR got there.
 *
 * Three of the four outcomes pass, which is the point: the check fires only on
 * the combination it is the sole signal for -- a listing difference with no
 * YAML change behind it. A YAML pull request has the #404 attestation, so this
 * logs and stands aside. An acknowledged pull request has been looked at by a
 * human and turned into a notice, because a difference here is not a missing
 * asset and re-running the promotion for every photo that moved is not the fix.
 * @param {{changes: ListingChange[], yamlChanged: boolean, acked: boolean, prNumber?: string}} input
 * @returns {{verdict: Verdict, lines: string[]}}
 */
export function listingCheckVerdict({ changes, yamlChanged, acked, prNumber }) {
  const lines = changes.map((change) => change.detail);
  if (changes.length === 0) return { verdict: "clean", lines };
  if (yamlChanged) {
    return {
      verdict: "logged",
      lines: [
        ...lines,
        "this pull request also changes content/photos/*.yaml, so the #404 attestation covers it; logging only",
      ],
    };
  }
  if (acked) {
    return {
      verdict: "acknowledged",
      lines: [
        `::notice::${ACK_LABEL} is on this pull request, so the listing difference below is a notice, not a failure`,
        ...lines,
      ],
    };
  }
  // The promotion command is copy-pasteable rather than described: the person
  // reading a red merge box is about to fix this by hand, and `--pr <number>`
  // is the one thing they would otherwise have to go and look up.
  const promote = prNumber
    ? `npm run publish-photos -- --promote --pr ${prNumber}`
    : "npm run publish-photos -- --promote --pr <number>";
  return {
    verdict: "failed",
    lines: [
      `::error::this PR changes production listings through code, and touches no content/photos/*.yaml, so the #404 attestation will not run.`,
      ...lines,
      "Promote the assets for these slugs before merging, or the release gate (release.yml's Verify production masters) will refuse to deploy:",
      `  ${promote}`,
      `Or label the pull request ${ACK_LABEL} if these assets are already promoted; the difference is then a notice.`,
      "Note: this check reads no bucket. It reports that the listing set moved, not that an object is missing.",
    ],
  };
}

/**
 * Built in the tree named by each module URL, so the base side runs the base
 * tree's validator and the base tree's key derivation.
 *
 * Every import is a file URL passed in the environment rather than a relative
 * specifier, because this code is evaluated with `--eval` from a directory that
 * has no source tree of its own. The extensionless imports *inside* those
 * modules still need `--import scripts/register.mjs`, which the caller passes
 * from the head tree: it resolves `./foo` to `./foo.ts` and nothing else.
 */
const DRIVER = `
const { buildCatalog } = await import(process.env.LISTING_MODULE);
const { listingSet } = await import(process.env.LISTING_CHECK_MODULE);
const { masterKeyFromSlug, printAssetKeyFromSlug } = await import(process.env.LISTING_LADDER_MODULE);
const result = buildCatalog({
  photosDir: process.env.LISTING_PHOTOS_DIR,
  outFile: process.env.LISTING_OUT_FILE,
});
if (!result.ok) {
  for (const problem of result.problems) process.stderr.write(problem + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(
  listingSet(result.photos, { masterKeyFromSlug, printAssetKeyFromSlug }),
));
`;

/**
 * Build one tree's listing set, in a separate process.
 *
 * Two processes because the two sides need two different copies of the same
 * modules, and one module registry can hold one copy of each. The head side is
 * this process's own tree; the base side is a worktree, whose
 * `node_modules` does not exist -- which is why the worktree is created inside
 * the head tree, so `yaml` resolves by walking up out of it.
 * @param {{tree: string, outFile: string, register: string, checkModule: string}} options
 * @returns {ListingEntry[]}
 */
function listingSetFor({ tree, outFile, register, checkModule }) {
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(register).href, "--input-type=module", "-e", DRIVER],
    {
      cwd: tree,
      encoding: "utf8",
      env: {
        ...process.env,
        LISTING_MODULE: pathToFileURL(path.join(tree, "scripts", "build-catalog.mjs")).href,
        LISTING_LADDER_MODULE: pathToFileURL(
          path.join(tree, "src", "domain", "catalog", "derivative-ladder.ts"),
        ).href,
        LISTING_CHECK_MODULE: pathToFileURL(checkModule).href,
        LISTING_PHOTOS_DIR: path.resolve(tree, PHOTOS_DIR),
        LISTING_OUT_FILE: path.resolve(outFile),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `listing-set build failed in ${tree}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

/**
 * CI entry.
 *
 * Reads nothing from the network and needs no token: base and head are both
 * commits in the checkout, and whether the PR touched photo YAML is answered by
 * comparing the two trees already on disk.
 */
export function main(env = process.env) {
  const cwd = env.PHOTO_LISTING_CWD ?? process.cwd();
  const acked = env.PHOTO_LISTING_ACKED === "true";
  const baseSha = env.BASE_SHA || git(["merge-base", "HEAD", "origin/main"], cwd);
  const headSha = env.HEAD_SHA || git(["rev-parse", "HEAD"], cwd);

  // Inside the head tree, not beside it: the worktree has no node_modules of its
  // own, and the base tree's build-catalog imports `yaml`. Node resolves it by
  // walking up out of scripts/, so the parent directory is the dependency.
  const baseTree = path.resolve(cwd, WORKTREE_DIR);
  rmSync(baseTree, { force: true, recursive: true });
  git(["worktree", "prune"], cwd);
  git(["worktree", "add", "--detach", baseTree, baseSha], cwd);

  try {
    const scratch = path.join(cwd, SCRATCH_DIR);
    const register = path.join(cwd, "scripts", "register.mjs");
    const checkModule = fileURLToPath(import.meta.url);

    const base = listingSetFor({
      tree: baseTree,
      outFile: path.join(scratch, "base-catalog.ts"),
      register,
      checkModule,
    });
    const head = listingSetFor({
      tree: cwd,
      outFile: path.join(scratch, "head-catalog.ts"),
      register,
      checkModule,
    });

    const yamlChanged =
      photoYamlFingerprint(path.join(baseTree, PHOTOS_DIR)) !==
      photoYamlFingerprint(path.join(cwd, PHOTOS_DIR));
    const { changed, changes } = diffListingSets(base, head);
    const { verdict, lines } = listingCheckVerdict({
      changes,
      yamlChanged,
      acked,
      prNumber: env.PR_NUMBER,
    });

    for (const line of lines) console.log(line);
    console.log(
      `base ${baseSha.slice(0, 8)} lists ${base.length} photo(s), head ${headSha.slice(0, 8)} lists ${head.length}: ${changed ? `${changes.length} difference(s)` : "no difference"}`,
    );

    return verdict === "failed" ? 1 : 0;
  } finally {
    // Both are cleaned up on the failure path too. A build that throws leaves a
    // worktree registered against the repository and a half-written catalog in
    // the tree, and the next run starts by removing them anyway -- doing it here
    // as well means a failed run leaves nothing behind for a developer who ran
    // this by hand.
    git(["worktree", "remove", "--force", baseTree], cwd);
    rmSync(baseTree, { force: true, recursive: true });
    rmSync(path.join(cwd, SCRATCH_DIR), { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    // Fail closed. A check that could not compare the two listing sets has not
    // established that they are equal, and reporting success there is the one
    // outcome that would make this worse than having no check at all.
    console.error(`photo-listing-check: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
/**
 * #406: the pull request that changes what production lists through *code*.
 *
 * Two halves, and they are worth separating because only one of them is the
 * obvious thing to test.
 *
 * The diff is the product: added, removed, renamed, re-hashed, key derivation
 * changed, nothing changed. It is pure, so it is tested with two literal listing
 * sets and no repository, no git, no runner.
 *
 * The workflow half is a claim about the *shape* of a gate, and the shape is
 * where it fails. A required check that can be skipped is the #404 failure mode
 * pointed the other way: GitHub blocks a pull request on a status that never
 * arrives, and the merge queue stops for a reason nobody can see. A required
 * check holding secrets would be worse. So the job is pinned to having no path
 * filter, no skip condition, no `environment:`, no `secrets.*`, and no
 * `pull_request_target` — none of which is enforced by the check passing, which
 * is exactly why it is asserted here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  diffListingSets,
  listingCheckVerdict,
  listingSet,
  photoYamlFingerprint,
} from "../scripts/photo-listing-check.mjs";

/**
 * A key derivation stands in for `derivative-ladder.ts`. The production one is
 * imported in the tests below rather than stubbed, because the point of the
 * parameter is that base and head can price listings differently, and a stub
 * spelled `prints/` in both places would pass every test while missing the bug
 * the parameter exists to prevent.
 */
const keys = {
  masterKeyFromSlug: (slug: string) => `prints/${slug}.jpg`,
  printAssetKeyFromSlug: (slug: string) => `print-assets/${slug}.jpg`,
};

const photo = (slug: string, sha: string, printSha = `p-${slug}`) => ({
  slug,
  published: true,
  masterSha256: sha,
  printAsset: { sha256: printSha },
});

const set = (...slugs: [string, string][]) => listingSet(slugs.map(([s, sha]) => photo(s, sha)), keys);

test("the listing set carries the hashes and both bucket keys, sorted by slug", () => {
  // Sorted, because the failure message and these tests must agree on order
  // without either having to sort again.
  const entries = listingSet(
    [photo("dawn", "a".repeat(64)), photo("alley-cat", "b".repeat(64))],
    keys,
  );
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["alley-cat", "dawn"],
  );
  assert.deepEqual(entries[1], {
    slug: "dawn",
    masterSha256: "a".repeat(64),
    printAssetSha256: "p-dawn",
    masterKey: "prints/dawn.jpg",
    printAssetKey: "print-assets/dawn.jpg",
  });
});

test("the listing set reads the ladder it is handed, not one it hard-codes", () => {
  // The whole point of passing the derivation in. A renamed bucket prefix moves
  // every key, and the check has to see it — see the keys-changed case below for
  // what that produces.
  const moved = {
    masterKeyFromSlug: (slug: string) => `masters/${slug}.jpg`,
    printAssetKeyFromSlug: (slug: string) => `print-assets/${slug}.jpg`,
  };
  const entries = listingSet([photo("dawn", "a".repeat(64))], moved);
  assert.equal(entries[0].masterKey, "masters/dawn.jpg");
  // Same hashes on both sides, so the only thing that can have moved is the key.
  const base = set(["dawn", "a".repeat(64)]);
  assert.deepEqual(diffListingSets(base, entries).changes[0].kind, "keys-changed");
});

test("an unchanged catalog produces no difference", () => {
  const listing = set(["dawn", "a"], ["alley-cat", "b"]);
  const result = diffListingSets(listing, listing);
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
});

test("a newly listed photo is reported as added", () => {
  const result = diffListingSets(set(["dawn", "a"]), set(["dawn", "a"], ["alley-cat", "b"]));
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.slug]),
    [["added", "alley-cat"]],
  );
});

test("a photo that is no longer published is reported as removed", () => {
  const result = diffListingSets(set(["dawn", "a"], ["alley-cat", "b"]), set(["dawn", "a"]));
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.slug]),
    [["removed", "alley-cat"]],
  );
});

test("a rename is one change, not a removal plus an addition", () => {
  // The slug is the filename, so a rename arrives as two different slugs and
  // nothing says they are the same photo. The master hash is what survives the
  // rename, so that is what pairs them. It only changes how the failure reads:
  // unpaired, the same two entries are reported as a removal and an addition
  // and the check still fires.
  const result = diffListingSets(set(["dawn", "a"]), set(["first-light", "a"]));
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.slug, change.from]),
    [["renamed", "first-light", "dawn"]],
  );
});

test("two photos with different masters are not a rename", () => {
  // The other half of the pairing rule: same slug shape, different bytes, so a
  // remove-and-add is what actually happened and saying "renamed" would be a
  // guess dressed as a fact.
  const result = diffListingSets(set(["dawn", "a"]), set(["first-light", "b"]));
  // Sorted by slug, so `dawn` is reported before `first-light` whichever way
  // round the two actually happened.
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.slug]),
    [
      ["removed", "dawn"],
      ["added", "first-light"],
    ],
  );
});

test("a re-hashed photo is reported as rehashed, naming what moved", () => {
  const before = listingSet([{ ...photo("dawn", "a".repeat(64)), printAsset: { sha256: "p1" } }], keys);
  const after = listingSet([{ ...photo("dawn", "b".repeat(64)), printAsset: { sha256: "p2" } }], keys);
  const result = diffListingSets(before, after);
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.fields]),
    [["rehashed", ["master sha256", "print asset sha256"]]],
  );
});

test("a print asset re-hash alone is reported without dragging the master in", () => {
  // The two hashes are separate objects in the bucket, so a print-only re-hash
  // names one thing to promote. Reporting both would send someone to re-upload
  // a master that did not change.
  const before = listingSet([photo("dawn", "a".repeat(64))], keys);
  const after = listingSet([photo("dawn", "a".repeat(64), "p2")], keys);
  assert.deepEqual(
    diffListingSets(before, after).changes.map((change) => change.fields),
    [["print asset sha256"]],
  );
});

test("a key-derivation change names every listed photo it moves", () => {
  // #406's second example. Editing `MASTER_KEY_PREFIX` changes no YAML and no
  // hash, so the #404 attestation never runs and this is the only PR-time
  // signal that production is about to ask for objects under keys nobody has
  // promoted.
  const base = listingSet(
    [photo("dawn", "a".repeat(64)), photo("alley-cat", "b".repeat(64))],
    keys,
  );
  const head = listingSet([photo("dawn", "a".repeat(64)), photo("alley-cat", "b".repeat(64))], {
    masterKeyFromSlug: (slug) => `masters/${slug}.jpg`,
    printAssetKeyFromSlug: (slug) => `print-assets/${slug}.jpg`,
  });
  const result = diffListingSets(base, head);
  assert.deepEqual(
    result.changes.map((change) => [change.slug, change.fields]),
    [
      ["alley-cat", ["master key"]],
      ["dawn", ["master key"]],
    ],
  );
});

test("a listing that moved and a key that moved are two changes, not one", () => {
  // Both are actionable and they are actionable separately: one needs a
  // promotion, the other needs the ladder to be put back.
  const base = listingSet([photo("dawn", "a".repeat(64))], keys);
  const head = listingSet([photo("dawn", "b".repeat(64))], {
    masterKeyFromSlug: (slug) => `masters/${slug}.jpg`,
    printAssetKeyFromSlug: (slug) => `print-assets/${slug}.jpg`,
  });
  assert.deepEqual(
    diffListingSets(base, head).changes.map((change) => change.kind).sort(),
    ["keys-changed", "rehashed"],
  );
});

/* -- the verdict --------------------------------------------------------- */

const oneChange = [
  { kind: "added", slug: "alley-cat", fields: [], detail: "newly listed: alley-cat" },
] as never;

test("a difference with no YAML change behind it fails, and names the slugs", () => {
  const { verdict, lines } = listingCheckVerdict({
    changes: oneChange,
    yamlChanged: false,
    acked: false,
    prNumber: "406",
  });
  assert.equal(verdict, "failed");
  assert.ok(lines.some((line) => line.includes("alley-cat")));
  // Copy-pasteable on purpose: the person reading a red merge box should not
  // have to go and look up the PR number they are already on.
  assert.ok(lines.some((line) => line.trim() === "npm run publish-photos -- --promote --pr 406"));
});

test("a YAML pull request logs the difference and passes", () => {
  // The #404 attestation runs for these, so failing here as well would be a
  // second gate on the same PR-time signal, and the advisory escape hatch would
  // have to be applied to two checks.
  const { verdict } = listingCheckVerdict({
    changes: oneChange,
    yamlChanged: true,
    acked: false,
  });
  assert.equal(verdict, "logged");
});

test("the ack label turns the failure into a notice", () => {
  // An explicit human act, and the only one: a difference here is not proof of a
  // missing object, and the assets are often already promoted.
  const { verdict, lines } = listingCheckVerdict({
    changes: oneChange,
    yamlChanged: false,
    acked: true,
  });
  assert.equal(verdict, "acknowledged");
  assert.ok(lines.some((line) => line.startsWith("::notice::")));
  assert.ok(!lines.some((line) => line.startsWith("::error::")));
});

test("no difference is clean whatever the label says", () => {
  assert.equal(
    listingCheckVerdict({ changes: [], yamlChanged: false, acked: false }).verdict,
    "clean",
  );
});

/* -- the YAML fingerprint ------------------------------------------------ */

test("the YAML fingerprint moves for a content edit, a rename and a deletion", () => {
  // This is what answers "did the PR touch photo YAML?", which decides whether
  // the #404 attestation will run. Answered from the two trees already on disk
  // rather than from the API, so there is no token to hold and no fork caveat.
  const dir = mkdtempSync(path.join(os.tmpdir(), "listing-fingerprint-"));
  try {
    const write = (name: string, body: string) =>
      writeFileSync(path.join(dir, name), body);
    write("dawn.yaml", "title: Dawn\n");
    const original = photoYamlFingerprint(dir);
    assert.equal(photoYamlFingerprint(dir), original, "the fingerprint is stable");

    write("dawn.yaml", "title: Dawn, edited\n");
    assert.notEqual(photoYamlFingerprint(dir), original, "a content edit must move it");

    write("dawn.yaml", "title: Dawn\n");
    assert.equal(photoYamlFingerprint(dir), original);

    mkdirSync(path.join(dir, "subdir"), { recursive: true });
    write("subdir/notes.yaml", "title: Notes\n");
    assert.equal(
      photoYamlFingerprint(dir),
      original,
      "the fingerprint is the catalog directory, not the whole tree",
    );

    rmSync(path.join(dir, "subdir"), { recursive: true, force: true });
    write("second.yaml", "title: Second\n");
    assert.notEqual(photoYamlFingerprint(dir), original, "a new listing must move it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that is not there fingerprints as empty, not as a crash", () => {
  // An empty base is a difference to report, not an exception: the check fails
  // closed either way, but it fails with a message instead of a stack.
  assert.equal(photoYamlFingerprint(path.join(os.tmpdir(), "listing-check-absent")), "");
});

/* -- the gate's shape ---------------------------------------------------- */

const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobBlock(id: string): string {
  const match = new RegExp(String.raw`^ {2}${id}:\n((?:(?: {4}|\t).*\n|\n)*)`, "m").exec(ci);
  assert.ok(match, `ci.yml has no ${id} job`);
  return match[1];
}

const job = jobBlock("photo-listing-check");

test("the check is a named job in ci.yml, and its name is a required status check", () => {
  // The name is what branch protection matches on, so the two have to be the
  // same string. .github/required-checks.txt is the committed half; the live
  // rule is reconciled by hand (DEVELOPMENT.md §Required status checks).
  assert.match(job, /^\s+name: Photo listing check$/m);
  const required = fs
    .readFileSync(new URL("../.github/required-checks.txt", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim());
  assert.ok(
    required.includes("Photo listing check"),
    "Photo listing check is not in .github/required-checks.txt, so a red run would not block the merge",
  );
});

test("the check cannot be skipped", () => {
  // #404, inverted. `Photo master promotion` was a required context posted by a
  // path-filtered workflow: on a pull request touching no photo YAML the status
  // never arrived, stayed pending, and blocked the merge forever. This job is
  // required, so the only condition it may carry is one that is true for every
  // pull request — the release.yml caller has no pull_request payload to compare.
  assert.doesNotMatch(
    ci,
    /^\s{4}paths(-ignore)?:/m,
    "ci.yml gained a path filter; a required check that does not report blocks the merge forever (#404)",
  );
  assert.doesNotMatch(
    job,
    /continue-on-error/,
    "the job must not be continue-on-error: tests/branch-protection.test.mts refuses to require one, and a soft check gates nothing",
  );
  const conditions = [...job.matchAll(/^\s+if:\s*(.+)$/gm)].map((match) => match[1].trim());
  for (const condition of conditions) {
    assert.match(
      condition,
      /^github\.event_name\s*==\s*'pull_request'$/,
      `the only if-condition this job may carry is the pull_request guard, because that is true for every pull request; found: ${condition}`,
    );
  }
});

test("the check holds nothing worth stealing and runs nothing unreviewed", () => {
  // It executes the pull request's own catalog builder — which is the design,
  // and is safe only because there is nothing here to take. `pull_request_target`
  // would give the same job a write token and a base-branch ref while still
  // running head's code, which is the combination #404 kept out.
  // The trigger, not the word: the job's comment names the trigger it refuses,
  // and an assertion that matched the prose would forbid explaining the rule.
  assert.doesNotMatch(
    ci,
    /^\s*pull_request_target:/m,
    "ci.yml must not use pull_request_target",
  );
  assert.doesNotMatch(job, /secrets\./, "the job must read no secret");
  assert.doesNotMatch(job, /^ {4}environment:/m, "the job must not reach a gated environment");
  assert.doesNotMatch(job, /id-token/, "the job must not request an OIDC token");
  assert.match(job, /actions\/checkout@[0-9a-f]{40}/, "checkout stays SHA-pinned");
  assert.match(job, /persist-credentials: false/, "checkout must not persist its token");
  assert.match(
    job,
    /scripts\/photo-listing-check\.mjs/,
    "the job must run the check script, not an inline copy of the comparison",
  );
});

test("the job fetches the history it needs to find the base", () => {
  // A shallow checkout has no `origin/main`, and `git merge-base` fails on a
  // missing ref. This fails the job closed rather than comparing a base that
  // was silently assumed to be HEAD, which is the outcome where a PR changing
  // every listing reports "no difference".
  assert.match(job, /fetch-depth: 0/, "the base commit is unreachable without the full history");
});
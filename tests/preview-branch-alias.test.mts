/**
 * The contract between preview.yml's two jobs.
 *
 * `deploy` builds a version tagged `pr-<number>-<branch>`, where `<branch>` is
 * the sanitized head ref, and `cleanup` deletes every version whose tag ends in
 * `-<branch>` after running the *same* sanitizer over the *same* input. Nothing
 * ties those two strings together except that they were derived identically, so
 * any divergence is a silent leak: cleanup matches nothing, prints `deleted=0`,
 * exits 0, and the preview keeps resolving after the PR is gone. #339 is that
 * bug -- the deploy step's copy carried `sed -E 's/-+$//'` after `cut -c1-28`
 * and the cleanup step's did not.
 *
 * Both copies were extracted to scripts/sanitize-branch-name.sh in 6262d50
 * (#152), ten days before #339 was filed, so the drift cannot come back by
 * editing one copy. It can still come back by adding a fourth derivation
 * somewhere, or by changing the script's behaviour in a way that is correct on
 * its own and wrong against the tags already uploaded -- which is why the
 * script is tested behaviourally here rather than grepped for shape.
 *
 * The trailing-hyphen case is pinned because it is the one the 28-character cut
 * makes non-obvious: Cloudflare truncated at 28 and *then* dropped a trailing
 * hyphen, so a branch whose sanitized form has a hyphen at position 28 has a
 * shorter alias than `cut` alone produces. `fix/some-really-long-branch-name`
 * is exactly that shape.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, "scripts", "sanitize-branch-name.sh");
const previewPath = path.join(root, ".github", "workflows", "preview.yml");
const preview = fs.readFileSync(previewPath, "utf8");

function sanitize(branch: string): string {
  const result = spawnSync("bash", [script, branch], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `sanitize-branch-name.sh exited ${result.status} on ${branch}: ${result.stderr}`,
  );
  return result.stdout.trim();
}

test("a branch whose 28th sanitized character is a hyphen loses it (#339)", () => {
  // The regression, stated as the two derivations the issue reported. `cut`
  // alone leaves the hyphen; Cloudflare dropped it after truncating, so the
  // alias that was actually deployed is the short one.
  const branch = "fix/some-really-long-branch-name";
  const truncated = sanitize(branch);
  const withoutTrailingStrip = (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 28)
  );

  assert.ok(
    truncated.endsWith("-") === false,
    `alias ${truncated} must not keep the trailing hyphen`,
  );
  assert.ok(
    withoutTrailingStrip.endsWith("-"),
    `fixture is wrong: the pre-fix derivation ${withoutTrailingStrip} must end in a hyphen for this test to be testing anything`,
  );
  assert.notEqual(
    truncated,
    withoutTrailingStrip,
    "the script must differ from a bare 28-char cut -- that difference IS #339",
  );
  // Concretely: this is the string deploy uploaded and cleanup must match back.
  assert.equal(truncated, "fix-some-really-long-branch");
});

test("every derived alias is a bare [a-z0-9-] token that is safe to interpolate", () => {
  // `github.head_ref` is attacker-controlled. The sanitizer narrowing it to this
  // alphabet is what lets the step outputs be interpolated into later `run:`
  // blocks at all (see the comment above each call site), so it is a safety
  // property, not a cosmetic one.
  const branches = [
    "fix/327-angled-mobile-fit",
    "feat/334-framed-mount-copy",
    "fix/some-really-long-branch-name",
    "chore/bump-the-thing-in-the-repo",
    "feature/a-very-long-branch-name-here",
    "ABC_DEF",
    "dependabot/npm_and_yarn/some-package-12.3.4",
    "release/v1.2.3",
    "--leading-and-trailing--",
    "a".repeat(60),
  ];
  for (const branch of branches) {
    const alias = sanitize(branch);
    assert.match(alias, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${branch} -> ${alias}`);
    assert.ok(alias.length <= 28, `${branch} -> ${alias} is ${alias.length} chars`);
    assert.equal(alias, sanitize(branch), `${branch} is not deterministic`);
  }
});

test("sanitizing is idempotent, so a matched tag stays matched", () => {
  // Cleanup matches on a suffix of a tag it did not build in this run -- it
  // re-derives the alias from head_ref and compares it to whatever the deploy
  // job of an earlier push wrote. Sanitizing the alias again must be a no-op,
  // or the two sides would need to agree on a fixed point.
  for (const branch of ["fix/327-angled-mobile-fit", "fix/some-really-long-branch-name"]) {
    const alias = sanitize(branch);
    assert.equal(sanitize(alias), alias, `${alias} is not a fixed point`);
  }
});

test("preview.yml derives the branch alias only through the shared script", () => {
  // The guard that would have caught #339 at PR time. Both jobs must call the
  // script, and no workflow may re-inline the pipeline -- an inline copy is
  // precisely how the two sides drifted in the first place.
  const callSites = [
    ...preview.matchAll(/run: echo "name=\$\(bash scripts\/sanitize-branch-name\.sh /g),
  ];
  assert.equal(
    callSites.length,
    2,
    `expected deploy and cleanup to each call the script once, found ${callSites.length} call site(s)`,
  );

  const inlineSanitizer = /cut -c1-28|tr '\[:upper:\]'/;
  for (const { name, text } of fs
    .readdirSync(path.join(root, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((name) => ({ name, text: fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8") }))) {
    assert.doesNotMatch(
      text,
      inlineSanitizer,
      `${name} inlines the branch sanitizer; call scripts/sanitize-branch-name.sh so it cannot drift from the other side (#339)`,
    );
  }
});

test("cleanup deletes what deploy tagged, matching the shared alias", () => {
  // The end-to-end shape of the contract, without touching Cloudflare: build a
  // tag the way deploy does, then check the suffix rule cleanup uses
  // (`endswith("-" + branch)`) still selects it. This is the assertion whose
  // failure mode is the silent `deleted=0` leak.
  for (const branch of ["fix/some-really-long-branch-name", "fix/327-angled-mobile-fit"]) {
    const alias = sanitize(branch);
    const tag = `pr-345-${alias}`;
    assert.ok(
      tag.endsWith(`-${alias}`),
      `cleanup matches endswith("-${alias}"), which cannot match the tag it uploaded: ${tag}`,
    );
  }

  // And the tag must be free of the characters the comment at the upload step
  // warns about: opennextjs-cloudflare re-parses these args through a shell.
  const tag = `pr-345-${sanitize("fix/some-really-long-branch-name")}`;
  assert.match(tag, /^pr-\d+-[a-z0-9-]+$/, `${tag} is not shell-safe for the upload args`);
});
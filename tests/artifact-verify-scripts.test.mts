/**
 * The two scripts the release pipeline runs before it deploys anything:
 * `artifact-manifest.sh` (the tree survived the artifact round-trip unchanged)
 * and `assert-artifact-origin.sh` (the tree was built for *this* environment).
 *
 * Behavioural, not source-grepped, because both scripts are bash and the failure
 * modes that matter are not visible in their text. The specific one this file
 * exists for: `assert-artifact-origin.sh` counts matching files with
 * `grep -rl | wc -l`, and `grep -rl` exits 1 when it matches nothing. Under
 * `set -e` + `pipefail` that aborted the script on the *passing* path — a
 * correctly built staging artifact has zero references to the production
 * origin, which is the check succeeding, and grep reports that as an error.
 * The staging deploy job then failed with exit 1 and no output at all, and the
 * first version of the script was verified only by reading it.
 *
 * So: these run the real script against a fixture tree and assert both the
 * exit code and that the failure path says something.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const manifestScript = path.join(root, "scripts", "artifact-manifest.sh");
const originScript = path.join(root, "scripts", "assert-artifact-origin.sh");

const PROD = "https://nessebarlens.com";
const STAGING = "https://staging.nessebarlens.com";

/**
 * A stand-in for a built .open-next/: nested files, and optionally a symlink,
 * because the manifest's symlink refusal needs one to fire.
 */
function fixtureTree(files: Record<string, string>, link?: [string, string]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-next-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  if (link) {
    const [target, name] = link;
    fs.symlinkSync(path.join(dir, target), path.join(dir, name));
  }
  return dir;
}

function run(script: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("assert-artifact-origin passes on a tree built for the right environment", () => {
  // The regression. Zero forbidden-origin matches is the success case, and it
  // must exit 0 -- not 1 with an empty message from `set -e` eating a `grep`
  // status that nobody meant to assert on.
  const dir = fixtureTree({
    "server.js": `<meta property="og:url" content="${STAGING}/print/1">`,
    "assets/chunk.js": `"siteUrl":"${STAGING}"`,
  });
  const { status, out } = run(originScript, [dir, STAGING, PROD]);
  assert.equal(status, 0, `expected a clean pass, got ${status}: ${out}`);
  assert.match(out, /is built for https:\/\/staging\.nessebarlens\.com/);
});

test("assert-artifact-origin fails when the artifact is the other environment's", () => {
  // The swapped-artifact-name case this check exists for.
  const dir = fixtureTree({ "server.js": `canonical ${PROD}` });
  const { status, out } = run(originScript, [dir, STAGING, PROD]);
  assert.equal(status, 1);
  assert.match(out, /carries no reference to https:\/\/staging\.nessebarlens\.com/);
});

test("assert-artifact-origin fails when the tree carries both origins", () => {
  // Found-the-expected-alone would pass this tree, which is exactly the case
  // where somebody edited a matrix leg and left a stale variable next to a
  // correct one.
  const dir = fixtureTree({
    "server.js": `canonical ${PROD}`,
    "assets/leftover.js": `siteUrl ${STAGING}`,
  });
  const { status, out } = run(originScript, [dir, STAGING, PROD]);
  assert.equal(status, 1);
  assert.match(out, /references https:\/\/nessebarlens\.com in 1 files/);
});

test("assert-artifact-origin reports a missing directory rather than passing", () => {
  const { status, out } = run(originScript, ["/nonexistent/tree", STAGING, PROD]);
  assert.equal(status, 1);
  assert.match(out, /is not a directory/);
});

test("assert-artifact-origin refuses to run without all three arguments", () => {
  // A check invoked with a missing variable must fail loudly, not grep the
  // current directory or treat "" as an origin that is legitimately absent.
  for (const args of [[], ["/tmp"], ["/tmp", STAGING]]) {
    const { status, out } = run(originScript, args as string[]);
    assert.equal(status, 2, `args ${JSON.stringify(args)} should be a usage error`);
    assert.match(out, /usage: assert-artifact-origin\.sh/);
  }
});

test("artifact-manifest round-trips an unchanged tree", () => {
  const dir = fixtureTree({ "worker.js": "export default {}", "assets/a.js": "x" });
  const manifest = path.join(dir, "MANIFEST.sha256");
  assert.equal(run(manifestScript, ["write", dir, manifest]).status, 0);
  const { status, out } = run(manifestScript, ["check", dir, manifest]);
  assert.equal(status, 0, out);
  assert.match(out, /matches the build-time manifest \(2 files\)/);
});

test("artifact-manifest catches a tree the round-trip changed", () => {
  // Stands in for anything that alters the tree between build and deploy. The
  // deploy job trusts a tree it did not build, so this is the boundary.
  const dir = fixtureTree({ "worker.js": "export default {}", "assets/a.js": "x" });
  const manifest = path.join(dir, "MANIFEST.sha256");
  run(manifestScript, ["write", dir, manifest]);
  fs.writeFileSync(path.join(dir, "assets/a.js"), "tampered");
  const { status, out } = run(manifestScript, ["check", dir, manifest]);
  assert.equal(status, 1);
  assert.match(out, /does not match the manifest recorded at build time/);
});

test("artifact-manifest refuses to record a tree containing symlinks", () => {
  // upload-artifact stores files, so a symlink would be silently dereferenced
  // and the deploy would run against a different tree than the one built. The
  // refusal has to happen at `write`, or the manifest describes a tree that is
  // not the built one.
  const dir = fixtureTree(
    { "worker.js": "export default {}", "assets/a.js": "x" },
    ["assets/a.js", "assets/link.js"],
  );
  const { status, out } = run(manifestScript, ["write", dir, path.join(dir, "M.sha256")]);
  assert.equal(status, 1);
  assert.match(out, /contains symlinks/);
});

test("artifact-manifest refuses an empty tree instead of writing a vacuous manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-next-empty-"));
  const { status, out } = run(manifestScript, ["write", dir, path.join(dir, "M.sha256")]);
  assert.equal(status, 1);
  assert.match(out, /has no files/);
});

test("artifact-manifest fails when the manifest did not travel with the artifact", () => {
  const dir = fixtureTree({ "worker.js": "export default {}" });
  const { status, out } = run(manifestScript, ["check", dir, path.join(dir, "absent.sha256")]);
  assert.equal(status, 1);
  assert.match(out, /no manifest at/);
});
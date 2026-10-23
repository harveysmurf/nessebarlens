/**
 * Three version floors that only work together, and nothing held them
 * together.
 *
 * The chain: Next 16.4 loads `.next/server/preview-props.json` at server boot
 * (`NextNodeServer.getPreviewProps`), and OpenNext's Worker shim inlines
 * `loadManifest` with a whitelist, so a shim that does not know that manifest
 * makes the Worker boot and then 500 every request -- the failure #367 held
 * `next` at 16.3.x for. @opennextjs/cloudflare 1.20.12 is the first release
 * whose `load-manifest.js` inlines it. But 1.20.12 pulls @opennextjs/aws
 * 4.1.11+, which pulls @node-minify/core 9.x, which pins glob 10.3.3 -- inside
 * the affected range of GHSA-5j98-mcp5-4vw2 (glob command injection, high).
 *
 * So the floors are not independent:
 *
 *   * next below 16.4.1 and the tree carries three advisories, two of them
 *     unauthenticated remote code execution -- the Image Optimization API with
 *     SVG files and `use cache` functions returning typed arrays;
 *   * opennext below 1.20.12 and the Worker boots and then 500s every
 *     request, because Next 16.4 loads a manifest the older shim does not
 *     inline;
 *   * glob below 10.5.0 and the tree carries a high-severity advisory, which
 *     Dependabot's security updates would open a PR for.
 *
 * Each of the three is a one-line change in package.json, and each of the
 * three alone leaves the tree broken in a way the suite does not notice: the
 * Worker only boots in the E2E Worker runtime job, and `npm audit` is not a CI
 * step. The floors live here so a downgrade fails the suite instead.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

type Version = { major: number; minor: number; patch: number };

function parseVersion(raw: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  assert.ok(m, `not a plain version: ${JSON.stringify(raw)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The lowest `next` outside the affected range of the three advisories, and
 * also the lowest `next` the `@opennextjs/cloudflare` peer range admits
 * (`>=15.5.28 <16 || >=16.4.1`). Both floors land on 16.4.1: npm's advisory
 * data gives the affected range as 16.0.0 - 16.4.0, and the v16.4.1 release
 * notes are the ones that name the three advisories.
 */
const NEXT_FLOOR = "16.4.1";

/**
 * The lowest `@opennextjs/cloudflare` whose `load-manifest.js` inlines
 * `server/preview-props.json`.
 */
const OPENNEXT_FLOOR = "1.20.12";

/**
 * The lowest `glob` outside the range GHSA-5j98-mcp5-4vw2 covers.
 */
const GLOB_FLOOR = "10.5.0";

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, Record<string, string>>;
};
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
) as {
  packages: Record<string, { version?: string }>;
};

/** The `^`/`~`/exact prefix npm allows in a dependency range, dropped. */
function rangeFloor(range: string): Version {
  return parseVersion(range.replace(/^[\^~>=<\s]+/, ""));
}

test("next is not below the version that closes the advisories", () => {
  const declared = pkg.dependencies?.next;
  assert.ok(declared, "package.json no longer declares next");
  assert.ok(
    compare(rangeFloor(declared), parseVersion(NEXT_FLOOR)) >= 0,
    `next is pinned at ${declared}, below ${NEXT_FLOOR}`,
  );
});

test("@opennextjs/cloudflare is not below the release that inlines preview-props.json", () => {
  const declared = pkg.devDependencies?.["@opennextjs/cloudflare"];
  assert.ok(declared, "package.json no longer declares @opennextjs/cloudflare");
  assert.ok(
    compare(rangeFloor(declared), parseVersion(OPENNEXT_FLOOR)) >= 0,
    `@opennextjs/cloudflare is floored at ${declared}, below ${OPENNEXT_FLOOR} -- its Worker shim does not inline ` +
      "server/preview-props.json, so the Worker boots and 500s every request",
  );
});

test("the glob override pins the patched glob under @node-minify/core", () => {
  const pinned = pkg.overrides?.["@node-minify/core"]?.glob;
  assert.ok(
    pinned,
    "package.json has no `overrides[\"@node-minify/core\"].glob` -- @node-minify/core pins glob 10.3.3, " +
      "which is inside the range GHSA-5j98-mcp5-4vw2 covers",
  );
  assert.ok(
    compare(rangeFloor(pinned), parseVersion(GLOB_FLOOR)) >= 0,
    `the glob override pins ${pinned}, below ${GLOB_FLOOR}`,
  );
});

test("the lockfile resolves every one of those floors at or above them", () => {
  // The floors above are what package.json asks for; this is what gets
  // installed. A lockfile that resolved lower is the tree CI actually builds.
  const resolved: [string, string][] = [
    ["node_modules/next", NEXT_FLOOR],
    ["node_modules/@opennextjs/cloudflare", OPENNEXT_FLOOR],
    ["node_modules/@node-minify/core/node_modules/glob", GLOB_FLOOR],
  ];

  for (const [key, floor] of resolved) {
    const version = lock.packages[key]?.version;
    assert.ok(version, `package-lock.json has no ${key}`);
    assert.ok(
      compare(parseVersion(version), parseVersion(floor)) >= 0,
      `package-lock.json resolves ${key} to ${version}, below ${floor}`,
    );
  }
});

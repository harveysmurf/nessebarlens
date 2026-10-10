/**
 * The pure print-asset decision (#307): which way a master is turned for the
 * portrait Prodigi print area, and which key a photo's asset lives under.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { printAssetRotation } from "../src/domain/catalog/print-asset.ts";
import { printAssetKeyForSlug } from "../src/domain/catalog/master-key.ts";

test("printAssetRotation turns landscape 90° clockwise and leaves the rest (#307)", () => {
  assert.equal(printAssetRotation("landscape"), 90);
  assert.equal(printAssetRotation("portrait"), 0);
  assert.equal(printAssetRotation("square"), 0);
});

test("printAssetKeyForSlug is null until the catalog carries a print asset", () => {
  // No published photo has a print asset yet in this checkout, and an unknown
  // slug is always null. The serving path must fail closed rather than fall
  // back to the digital master, so a null is the whole contract here.
  assert.equal(printAssetKeyForSlug("not-a-photo"), null);
});

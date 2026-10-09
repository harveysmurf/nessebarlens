/**
 * master-facts: the orientation word for a pixel size, and the one validation
 * pass over the three raw values. The catalog schema's use of these lives in
 * tests/photo-schema.test.mts; the publish write lives in
 * tests/publish-photos.test.mts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ORIENTATIONS,
  orientationOf,
  parseMasterFacts,
} from "../src/domain/catalog/master-facts.ts";

test("orientationOf follows the longer edge, with square for a level frame", () => {
  assert.equal(orientationOf(4901, 3351), "landscape");
  assert.equal(orientationOf(3351, 4901), "portrait");
  assert.equal(orientationOf(4000, 4000), "square");
  assert.equal(orientationOf(1, 1), "square");
});

test("orientationOf's 1% square boundary is inclusive on both sides", () => {
  // Exactly 1.01 is square; one pixel beyond it is landscape.
  assert.equal(orientationOf(10100, 10000), "square");
  assert.equal(orientationOf(10101, 10000), "landscape");
  assert.equal(orientationOf(10000, 10100), "square");
  assert.equal(orientationOf(10000, 10101), "portrait");
  // Well inside the tolerance stays square.
  assert.equal(orientationOf(10050, 10000), "square");
});

test("orientationOf agrees with itself when the axes are swapped", () => {
  for (const [width, height] of [
    [4901, 3351],
    [10101, 10000],
    [10000, 10101],
    [4000, 4000],
  ] as const) {
    const upright = orientationOf(width, height);
    const flipped = orientationOf(height, width);
    if (upright === "square") {
      assert.equal(flipped, "square", `${width}x${height}`);
    } else {
      assert.notEqual(upright, flipped, `${width}x${height}`);
    }
  }
});

test("parseMasterFacts accepts a complete, consistent set", () => {
  assert.deepEqual(
    parseMasterFacts({ width: 4901, height: 3351, orientation: "landscape" }),
    { ok: true, facts: { width: 4901, height: 3351, orientation: "landscape" } },
  );
  for (const orientation of ORIENTATIONS) {
    const size =
      orientation === "landscape"
        ? { width: 4000, height: 3000 }
        : orientation === "portrait"
          ? { width: 3000, height: 4000 }
          : { width: 4000, height: 4000 };
    assert.deepEqual(parseMasterFacts({ ...size, orientation }), {
      ok: true,
      facts: { ...size, orientation },
    });
  }
});

test("parseMasterFacts refuses a size that is not a positive integer", () => {
  for (const [width, height] of [
    [0, 100],
    [-1, 100],
    [100, 0],
    [100.5, 100],
    ["100", 100],
    [100, null],
    [undefined, 100],
  ] as const) {
    assert.deepEqual(
      parseMasterFacts({ width, height, orientation: "landscape" }),
      { ok: false, reason: "not-positive-integer" },
      `${String(width)}x${String(height)}`,
    );
  }
});

test("parseMasterFacts refuses an unknown orientation", () => {
  for (const orientation of ["diagonal", "Landscape", "", 7, undefined]) {
    assert.deepEqual(
      parseMasterFacts({ width: 4000, height: 3000, orientation }),
      { ok: false, reason: "unknown-orientation" },
      String(orientation),
    );
  }
});

test("parseMasterFacts refuses an orientation that disagrees with the size", () => {
  assert.deepEqual(
    parseMasterFacts({ width: 4000, height: 3000, orientation: "portrait" }),
    { ok: false, reason: "orientation-mismatch" },
  );
  assert.deepEqual(
    parseMasterFacts({ width: 3000, height: 4000, orientation: "landscape" }),
    { ok: false, reason: "orientation-mismatch" },
  );
  assert.deepEqual(
    parseMasterFacts({ width: 4000, height: 3000, orientation: "square" }),
    { ok: false, reason: "orientation-mismatch" },
  );
});

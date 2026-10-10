/**
 * #311: the orientation decision, end to end.
 *
 * One EXIF-normalized measurement (#295) flows from the master file through
 * `orientationOf` and into #307's print-asset rotation. These tests pin the
 * five cases the print pipeline must get right — landscape, portrait,
 * EXIF-tagged portrait, exact square and near-square — by reading real pixels
 * with real `sharp`, not by inferring the result from the dimensions.
 *
 * They also prove the single-source contract and the fail-closed default:
 * orientation only ever comes from `masterDimensions` + `orientationOf`, and a
 * value that is not a known orientation never rotates rather than guessing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  masterDimensions,
  renderPrintAsset,
} from "../scripts/derivative-image.mjs";
import { orientationOf, parseMasterFacts } from "../src/domain/catalog/master-facts.ts";
import { printAssetRotation } from "../src/domain/catalog/print-asset.ts";

/**
 * A master with a red square top-left on a blue field, so a rotation is read
 * from the pixels rather than assumed from the dimensions. `orientation` writes
 * an EXIF tag (stored pixels unchanged); `masterDimensions` applies it.
 */
async function writeCornerMaster(
  file: string,
  { width, height, orientation }: { width: number; height: number; orientation?: number },
): Promise<void> {
  const red = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).composite([{ input: red, top: 0, left: 0 }]);
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await pipeline.jpeg({ quality: 90 }).toFile(file);
}

async function readPixels(file: string, orientation: string) {
  const out = await renderPrintAsset(readFileSync(file), orientation);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
  };
  return { width, height, at };
}

function isRed(px: { r: number; g: number; b: number }): boolean {
  return px.r > 200 && px.g < 80;
}

test("#311 print asset is upright for landscape, portrait, EXIF-6, square and near-square", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orientation-"));
  try {
    // Measure exactly the way the publish path does (`defaultMeasure`), so the
    // orientation tested is the one production would derive, from the file.
    const measure = async (file: string) => {
      const { width, height } = await masterDimensions(readFileSync(file));
      return { width, height, orientation: orientationOf(width, height) };
    };

    // (a) Landscape: turned 90° clockwise, so the red corner lands top-right
    //     and the asset is portrait — the shape Prodigi's print area expects.
    const landscape = path.join(dir, "landscape.jpg");
    await writeCornerMaster(landscape, { width: 3600, height: 2400 });
    const landscapeFacts = await measure(landscape);
    assert.equal(landscapeFacts.orientation, "landscape");
    const turned = await readPixels(landscape, landscapeFacts.orientation);
    assert.equal(turned.width, 2400);
    assert.equal(turned.height, 3600);
    assert.ok(isRed(turned.at(turned.width - 100, 100)), "landscape red corner is top-right");

    // (b) Portrait: not turned.
    const portrait = path.join(dir, "portrait.jpg");
    await writeCornerMaster(portrait, { width: 2400, height: 3600 });
    const portraitFacts = await measure(portrait);
    assert.equal(portraitFacts.orientation, "portrait");
    const upright = await readPixels(portrait, portraitFacts.orientation);
    assert.equal(upright.width, 2400);
    assert.equal(upright.height, 3600);
    assert.ok(isRed(upright.at(100, 100)), "portrait keeps the red corner top-left");

    // (c) EXIF orientation 6: stored landscape, seen as 2400×3600 portrait.
    //     `masterDimensions` swaps the axes, so the facts say portrait, and
    //     `autoOrient` applies the tag — no extra #307 turn is added.
    const tagged = path.join(dir, "tagged.jpg");
    await writeCornerMaster(tagged, { width: 3600, height: 2400, orientation: 6 });
    const taggedFacts = await measure(tagged);
    assert.equal(taggedFacts.width, 2400);
    assert.equal(taggedFacts.height, 3600);
    assert.equal(taggedFacts.orientation, "portrait");
    const taggedOut = await readPixels(tagged, taggedFacts.orientation);
    assert.equal(taggedOut.width, 2400);
    assert.equal(taggedOut.height, 3600);
    // Orientation 6 is "rotate 90° CW": the stored top-left red reads top-right.
    assert.ok(isRed(taggedOut.at(taggedOut.width - 100, 100)), "EXIF-6 red corner reads top-right");

    // (d) Exact square: not turned. Rotating a square would be a no-op anyway.
    const square = path.join(dir, "square.jpg");
    await writeCornerMaster(square, { width: 3000, height: 3000 });
    const squareFacts = await measure(square);
    assert.equal(squareFacts.orientation, "square");
    const squareOut = await readPixels(square, squareFacts.orientation);
    assert.equal(squareOut.width, 3000);
    assert.equal(squareOut.height, 3000);
    assert.ok(isRed(squareOut.at(100, 100)), "square keeps the red corner top-left");

    // (e) Near-square, at the 1.01 boundary: still square, so not turned. The
    //     ±1% error either way is far below what the fill crop discards, so no
    //     rotation is the safe call (see print-asset.ts).
    const nearSquare = path.join(dir, "near-square.jpg");
    await writeCornerMaster(nearSquare, { width: 10100, height: 10000 });
    const nearFacts = await measure(nearSquare);
    assert.equal(nearFacts.orientation, "square", "10100×10000 is within the 1.01 square tolerance");
    const nearOut = await readPixels(nearSquare, nearFacts.orientation);
    assert.equal(nearOut.width, 10100);
    assert.equal(nearOut.height, 10000);
    assert.ok(isRed(nearOut.at(100, 100)), "near-square is not turned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#311 one pixel past the square tolerance is landscape and turns", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orientation-edge-"));
  try {
    const file = path.join(dir, "edge.jpg");
    await writeCornerMaster(file, { width: 10101, height: 10000 });
    const { width, height } = await masterDimensions(readFileSync(file));
    assert.equal(orientationOf(width, height), "landscape");
    const turned = await readPixels(file, "landscape");
    assert.equal(turned.width, 10000);
    assert.equal(turned.height, 10101);
    assert.ok(isRed(turned.at(turned.width - 100, 100)), "the just-over boundary turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#311 a malformed or unknown orientation never rotates", () => {
  // The domain type is a closed union, so production code cannot reach the
  // rotation with garbage. These pin the defensive default anyway: anything
  // that is not "landscape" is left alone rather than guessed at.
  assert.equal(printAssetRotation("diagonal" as never), 0);
  assert.equal(printAssetRotation("" as never), 0);
  assert.equal(printAssetRotation(undefined as never), 0);
});

test("#311 the catalog schema rejects a malformed or mismatched orientation", () => {
  assert.deepEqual(parseMasterFacts({ width: 3600, height: 2400, orientation: "diagonal" }), {
    ok: false,
    reason: "unknown-orientation",
  });
  assert.deepEqual(parseMasterFacts({ width: 3600, height: 2400 }), {
    ok: false,
    reason: "unknown-orientation",
  });
  // A well-formed word that disagrees with the pixels is refused, never
  // silently corrected — the stored facts and the checked facts are the same.
  assert.deepEqual(
    parseMasterFacts({ width: 3600, height: 2400, orientation: "portrait" }),
    { ok: false, reason: "orientation-mismatch" },
  );
});

test("#311 display facts and the print pipeline share one measurement", () => {
  // The catalog stores the facts measured at publish; the schema re-derives the
  // orientation from them to validate. Agreement here means the photo page's
  // dimensions and #307's rotation can never disagree about the master.
  for (const [width, height] of [
    [3600, 2400],
    [2400, 3600],
    [3000, 3000],
    [10100, 10000],
  ] as const) {
    const orientation = orientationOf(width, height);
    const parsed = parseMasterFacts({ width, height, orientation });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.facts, { width, height, orientation });
    }
  }
});

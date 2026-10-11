import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_GRAIN_SEED,
  frameGrain,
  type FrameSide,
} from "../src/components/print-preview-style.ts";

/**
 * The brown moulding grain (#332): an inline SVG data URI whose noise runs
 * *along* each piece. These assertions pin the orientation (so a future edit
 * cannot silently put the grain back across the moulding) and the per-side
 * seeds (so the four pieces stay distinct). The pixels themselves are covered
 * by e2e/print-preview.spec.ts, which attaches framed-brown at three widths.
 */

const SIDES: FrameSide[] = ["top", "right", "bottom", "left"];

function decode(background: string): string {
  const match = /^url\("data:image\/svg\+xml,(.*)"\)$/.exec(background);
  assert.ok(match, `not an svg data uri: ${background.slice(0, 40)}…`);
  return decodeURIComponent(match[1]!);
}

test("frameGrain returns a self-contained SVG data URI", () => {
  for (const side of SIDES) {
    const svg = decode(frameGrain(side, FRAME_GRAIN_SEED[side]));
    assert.match(svg, /^<svg /);
    assert.match(svg, /<feTurbulence type="fractalNoise"/);
    assert.match(svg, /<rect /);
    // No external asset: the filter and its result live inside the image.
    assert.match(svg, /filter="url\(#g\)"/);
  }
});

test("grain runs along the piece: horizontal rails, vertical stiles", () => {
  // A low x frequency and high y frequency stretch the noise horizontally (the
  // streaks run left-to-right); the stiles swap them (#332).
  assert.match(
    decode(frameGrain("top", 1)),
    /baseFrequency="0\.02 1\.5"/,
    "top rail should be horizontal",
  );
  assert.match(
    decode(frameGrain("bottom", 1)),
    /baseFrequency="0\.02 1\.5"/,
    "bottom rail should be horizontal",
  );
  assert.match(
    decode(frameGrain("left", 1)),
    /baseFrequency="1\.5 0\.02"/,
    "left stile should be vertical",
  );
  assert.match(
    decode(frameGrain("right", 1)),
    /baseFrequency="1\.5 0\.02"/,
    "right stile should be vertical",
  );
});

test("each side gets a distinct grain, deterministic per seed", () => {
  const perSide = SIDES.map((side) => frameGrain(side, FRAME_GRAIN_SEED[side]));
  assert.equal(new Set(perSide).size, SIDES.length, "sides are not copies");
  assert.equal(frameGrain("top", 7), frameGrain("top", 7), "deterministic");
  assert.notEqual(frameGrain("top", 7), frameGrain("top", 8), "seed matters");
});

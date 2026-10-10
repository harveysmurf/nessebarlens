import assert from "node:assert/strict";
import test from "node:test";

import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import { assess } from "../src/domain/catalog/print-eligibility.ts";
import {
  CANVAS_BAR_DEPTH_MM,
  CLASSIC_FRAME_MOULDING_MM,
  canvasSideFace,
  percentRect,
  previewGeometry,
  type CanvasSide,
  type PreviewGeometry,
} from "../src/domain/ordering/print-preview.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";
import { PRINT_PRODUCTS } from "../src/domain/pricing/print-products.ts";

/** The issue's reference master: 3:2 landscape, so the long edge is horizontal. */
const LANDSCAPE: MasterFacts = { width: 3000, height: 2000, orientation: "landscape" };
/** The same framing in portrait: x/y and width/height swap. */
const PORTRAIT: MasterFacts = { width: 2000, height: 3000, orientation: "portrait" };

function selection(
  format: PrintSelection["format"],
  size: PrintSelection["size"],
  frame: PrintSelection["frame"] = "black",
): PrintSelection {
  return { format, size, frame };
}

const TOL = 0.01;
function near(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `expected ${expected} ± ${TOL}, got ${actual}`,
  );
}

type Row = {
  name: string;
  selection: PrintSelection;
  outer: { width: number; height: number };
  mount?: { x: number; y: number; width: number; height: number };
  window?: { x: number; y: number; width: number; height: number };
  image: { x: number; y: number; width: number; height: number };
  crop: number;
};

/** The reference table from #326, for a 3000×2000 master. */
const ROWS: Row[] = [
  {
    name: "giclee 30x40",
    selection: selection("giclee", "30x40"),
    outer: { width: 406.4, height: 304.8 },
    image: { x: -25.4, y: 0, width: 457.2, height: 304.8 },
    crop: 0.1111,
  },
  {
    name: "giclee 50x70",
    selection: selection("giclee", "50x70"),
    outer: { width: 711.2, height: 508 },
    image: { x: -25.4, y: 0, width: 762, height: 508 },
    crop: 0.0667,
  },
  {
    name: "framed 30x40",
    selection: selection("framed", "30x40"),
    outer: { width: 446.4, height: 344.8 },
    mount: { x: 20, y: 20, width: 406.4, height: 304.8 },
    window: { x: 70.8, y: 70.8, width: 304.8, height: 203.2 },
    image: { x: 0, y: 0, width: 304.8, height: 203.2 },
    crop: 0,
  },
  {
    name: "framed 30x45",
    selection: selection("framed", "30x45"),
    outer: { width: 497.2, height: 344.8 },
    mount: { x: 20, y: 20, width: 457.2, height: 304.8 },
    window: { x: 70.04, y: 70.04, width: 357.12, height: 204.72 },
    image: { x: 0, y: -16.68, width: 357.12, height: 238.08 },
    crop: 0.1401,
  },
  {
    name: "canvas 20x30",
    selection: selection("canvas", "20x30"),
    outer: { width: 304.8, height: 203.2 },
    image: { x: -60.01, y: -40, width: 424.81, height: 283.21 },
    crop: 0.0942,
  },
  {
    name: "canvas 30x40",
    selection: selection("canvas", "30x40"),
    outer: { width: 406.4, height: 304.8 },
    image: { x: -85.41, y: -40.01, width: 577.22, height: 384.81 },
    crop: 0.1573,
  },
  {
    name: "canvas 70x100",
    selection: selection("canvas", "70x100"),
    outer: { width: 1016, height: 711.2 },
    image: { x: -101.6, y: -50.8, width: 1219.2, height: 812.8 },
    crop: 0.0833,
  },
];

test("previewGeometry matches the issue's reference table (±0.01 mm)", () => {
  for (const row of ROWS) {
    const geometry = previewGeometry(row.selection, LANDSCAPE);
    assert.notEqual(geometry.kind, "digital", row.name);

    if (row.selection.format === "giclee") {
      assert.equal(geometry.kind, "paper", row.name);
      if (geometry.kind !== "paper") return;
      near(geometry.outer.width, row.outer.width);
      near(geometry.outer.height, row.outer.height);
    } else if (row.selection.format === "framed") {
      assert.equal(geometry.kind, "framed", row.name);
      if (geometry.kind !== "framed") return;
      near(geometry.outer.width, row.outer.width);
      near(geometry.outer.height, row.outer.height);
      assert.ok(row.mount && row.window);
      near(geometry.mount.x, row.mount.x);
      near(geometry.mount.y, row.mount.y);
      near(geometry.mount.width, row.mount.width);
      near(geometry.mount.height, row.mount.height);
      near(geometry.window.x, row.window.x);
      near(geometry.window.y, row.window.y);
      near(geometry.window.width, row.window.width);
      near(geometry.window.height, row.window.height);
      near(geometry.mouldingMm, CLASSIC_FRAME_MOULDING_MM);
    } else {
      assert.equal(geometry.kind, "canvas", row.name);
      if (geometry.kind !== "canvas") return;
      near(geometry.front.width, row.outer.width);
      near(geometry.front.height, row.outer.height);
      near(geometry.depthMm, CANVAS_BAR_DEPTH_MM);
    }

    near(geometry.image.x, row.image.x);
    near(geometry.image.y, row.image.y);
    near(geometry.image.width, row.image.width);
    near(geometry.image.height, row.image.height);
    near(geometry.cropFraction, row.crop);
  }
});

test("a portrait master swaps the axes and keeps the crop", () => {
  // The issue: for portrait 2000×3000 the x and y values swap. Orientation
  // pairs the product's long edge with the master's, so the outer extent turns.
  const landscape = previewGeometry(selection("giclee", "30x40"), LANDSCAPE);
  const portrait = previewGeometry(selection("giclee", "30x40"), PORTRAIT);
  assert.equal(landscape.kind, "paper");
  assert.equal(portrait.kind, "paper");
  if (landscape.kind !== "paper" || portrait.kind !== "paper") return;
  near(portrait.outer.width, landscape.outer.height);
  near(portrait.outer.height, landscape.outer.width);
  near(portrait.image.x, landscape.image.y);
  near(portrait.image.y, landscape.image.x);
  near(portrait.image.width, landscape.image.height);
  near(portrait.image.height, landscape.image.width);
  near(portrait.cropFraction, landscape.cropFraction);
});

test("cropFraction equals assess() for every pinned product", () => {
  for (const master of [
    LANDSCAPE,
    { width: 2000, height: 2500, orientation: "portrait" } as MasterFacts,
  ]) {
    for (const product of PRINT_PRODUCTS) {
      const geometry = previewGeometry(
        selection(product.format, product.size),
        master,
      );
      assert.notEqual(geometry.kind, "digital", `${product.sku}`);
      if (geometry.kind === "digital") continue;
      const expected = assess(master, product).cropFraction;
      near(geometry.cropFraction, expected);
    }
  }
});

test("framed window ⊂ mount ⊂ outer for every pinned framed product", () => {
  for (const product of PRINT_PRODUCTS) {
    if (product.format !== "framed") continue;
    const geometry = previewGeometry(selection("framed", product.size), LANDSCAPE);
    assert.equal(geometry.kind, "framed", product.sku);
    if (geometry.kind !== "framed") continue;
    const { mount, window: win, outer } = geometry;
    assert.ok(win.x >= mount.x - TOL, product.sku);
    assert.ok(win.y >= mount.y - TOL, product.sku);
    assert.ok(win.x + win.width <= mount.x + mount.width + TOL, product.sku);
    assert.ok(win.y + win.height <= mount.y + mount.height + TOL, product.sku);
    assert.ok(mount.x >= -TOL && mount.y >= -TOL, product.sku);
    assert.ok(mount.x + mount.width <= outer.width + TOL, product.sku);
    assert.ok(mount.y + mount.height <= outer.height + TOL, product.sku);
  }
});

test("canvas wrap is at least the bar depth for every pinned canvas product", () => {
  for (const product of PRINT_PRODUCTS) {
    if (product.format !== "canvas") continue;
    const geometry = previewGeometry(selection("canvas", product.size), LANDSCAPE);
    assert.equal(geometry.kind, "canvas", product.sku);
    if (geometry.kind !== "canvas") continue;
    assert.ok(
      geometry.wrapMm.x >= geometry.depthMm - TOL,
      `${product.sku} x wrap ${geometry.wrapMm.x}`,
    );
    assert.ok(
      geometry.wrapMm.y >= geometry.depthMm - TOL,
      `${product.sku} y wrap ${geometry.wrapMm.y}`,
    );
  }
});

test("canvasSideFace matches the issue's reference table (±0.01 mm)", () => {
  const geometry = previewGeometry(selection("canvas", "30x40"), LANDSCAPE);
  assert.equal(geometry.kind, "canvas");
  if (geometry.kind !== "canvas") return;

  // Canvas 30x40, 3000×2000 master: front 406.4 × 304.8, depth 38, and
  // g.image = (−85.41, −40.01, 577.22, 384.81). The side image is that rect
  // moved to the face's top-left in the unfolded layout.
  const REFERENCE: Array<{
    side: CanvasSide;
    face: { width: number; height: number };
    image: { x: number; y: number; width: number; height: number };
  }> = [
    { side: "right", face: { width: 38, height: 304.8 }, image: { x: -491.81, y: -40.01, width: 577.22, height: 384.81 } },
    { side: "left", face: { width: 38, height: 304.8 }, image: { x: -47.41, y: -40.01, width: 577.22, height: 384.81 } },
    { side: "top", face: { width: 406.4, height: 38 }, image: { x: -85.41, y: -2.01, width: 577.22, height: 384.81 } },
    { side: "bottom", face: { width: 406.4, height: 38 }, image: { x: -85.41, y: -344.81, width: 577.22, height: 384.81 } },
  ];

  for (const row of REFERENCE) {
    const { face, image } = canvasSideFace(geometry, row.side);
    near(face.width, row.face.width);
    near(face.height, row.face.height);
    near(image.x, row.image.x);
    near(image.y, row.image.y);
    near(image.width, row.image.width);
    near(image.height, row.image.height);
  }
});

test("every canvas side face is depthMm deep and its photo band abuts the front", () => {
  for (const product of PRINT_PRODUCTS) {
    if (product.format !== "canvas") continue;
    const geometry = previewGeometry(selection("canvas", product.size), LANDSCAPE);
    assert.equal(geometry.kind, "canvas", product.sku);
    if (geometry.kind !== "canvas") continue;

    for (const side of ["top", "right", "bottom", "left"] as CanvasSide[]) {
      const { face } = canvasSideFace(geometry, side);
      const upright = side === "top" || side === "bottom";
      near(face.width, upright ? geometry.front.width : geometry.depthMm);
      near(face.height, upright ? geometry.depthMm : geometry.front.height);
    }

    // The right face's strip starts where the front ends, so the photo
    // continues across the fold with no seam.
    const right = canvasSideFace(geometry, "right");
    near(right.image.x, geometry.image.x - geometry.front.width);
  }
});

test("digital, and an unknown product, return { kind: 'digital' }", () => {
  assert.deepEqual(
    previewGeometry(selection("digital", "30x40"), LANDSCAPE),
    { kind: "digital" },
  );
  // A pair absent from the pinned table cannot happen for an offered
  // selection, but it must not throw.
  const miss: PreviewGeometry = previewGeometry(
    { format: "giclee", size: "1x1" as PrintSelection["size"], frame: "black" },
    LANDSCAPE,
  );
  assert.deepEqual(miss, { kind: "digital" });
});

test("percentRect formats a rect as CSS percentages of the box", () => {
  assert.deepEqual(
    percentRect(
      { x: -25.4, y: 0, width: 457.2, height: 304.8 },
      { width: 406.4, height: 304.8 },
    ),
    {
      left: "-6.2500%",
      top: "0.0000%",
      width: "112.5000%",
      height: "100.0000%",
    },
  );
});

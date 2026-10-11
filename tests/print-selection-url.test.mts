import assert from "node:assert/strict";
import test from "node:test";

import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_SIZE,
} from "../src/domain/ordering/print-copy.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";
import {
  selectionFromParams,
  selectionToParams,
} from "../src/domain/ordering/print-selection-url.ts";
import { FRAMED_MOUNTS, SELLABLE_FORMATS } from "../src/domain/pricing/sku-map.ts";

const OFFER: PrintOffer = {
  giclee: ["30x40", "50x70"],
  framed: ["30x40", "50x70"],
  canvas: [],
};

/** A framed expected selection, mount defaulting to the mounted product. */
function framed(size: string, frame = DEFAULT_FRAME_FINISH, mount = DEFAULT_FRAMED_MOUNT) {
  return { format: "framed", size, frame, mount };
}

function parse(query: string, offer: PrintOffer = OFFER): PrintSelection {
  return selectionFromParams(new URLSearchParams(query), offer);
}

test("a valid query reproduces that exact variation", () => {
  assert.deepEqual(parse("format=framed&size=50x70&frame=white"), framed("50x70", "white"));
  assert.deepEqual(parse("format=framed&size=50x70&frame=white&mount=none"), framed("50x70", "white", "none"));
  assert.deepEqual(parse("format=giclee&size=50x70"), {
    format: "giclee",
    size: "50x70",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("absent params fall back to the photo's opening selection", () => {
  assert.deepEqual(parse(""), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("an unknown format falls back to the opening format", () => {
  assert.deepEqual(parse("format=poster"), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("a format the photo does not offer is not accepted, even if sellable", () => {
  // Canvas is a real format but this photo's canvas offer is empty, so the
  // param is ignored rather than opening a format with no size to show.
  assert.equal(parse("format=canvas").format, "giclee");
  // And a size that belongs to another format is not accepted for this one.
  assert.deepEqual(parse("format=giclee&size=999x999"), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("a size not offered by the chosen format falls back to its first size", () => {
  // 50x70 is a real size but not offered for a photo whose giclée offer is
  // only [30x40]; the format is honoured and the size defaults within it.
  const narrow: PrintOffer = { giclee: ["30x40"], framed: [], canvas: [] };
  assert.deepEqual(parse("format=giclee&size=50x70", narrow), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("the size fallback follows the queried format, not the opening one", () => {
  // The opening format is giclee (first size 50x70); framed sells 30x40. A bare
  // `?format=framed` must open framed on framed's own first size, never the
  // opening format's, or the select points at a size framed does not sell.
  const split: PrintOffer = { giclee: ["50x70"], framed: ["30x40"], canvas: [] };
  assert.deepEqual(parse("format=framed", split), framed("30x40"));
  // A size the queried format does not sell falls back to that format's first.
  assert.deepEqual(parse("format=framed&size=50x70", split), framed("30x40"));
});

test("a size is honoured for the opening format when format is absent", () => {
  assert.deepEqual(parse("size=50x70"), {
    format: "giclee",
    size: "50x70",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("frame and mount are only read for a framed selection", () => {
  assert.equal(parse("format=framed&frame=brown").frame, "brown");
  // An unknown finish falls back to the default.
  assert.equal(parse("format=framed&frame=chartreuse").frame, DEFAULT_FRAME_FINISH);
  // A frame or mount on a non-framed format is ignored, not rejected.
  assert.equal(parse("format=giclee&frame=white").frame, DEFAULT_FRAME_FINISH);
  assert.equal(parse("format=giclee&mount=none").mount, DEFAULT_FRAMED_MOUNT);
  // An unknown mount falls back to the default too.
  assert.equal(parse("format=framed&mount=sandwich").mount, DEFAULT_FRAMED_MOUNT);
});

test("digital ignores size, frame and mount params", () => {
  assert.deepEqual(parse("format=digital&size=50x70&frame=white&mount=none"), {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  });
});

test("a selection serialises to only the params its format has", () => {
  assert.equal(
    selectionToParams(framed("30x40", "white")).toString(),
    "format=framed&size=30x40&frame=white&mount=white",
  );
  assert.equal(
    selectionToParams(framed("30x40", "white", "none")).toString(),
    "format=framed&size=30x40&frame=white&mount=none",
  );
  assert.equal(
    selectionToParams({
      format: "giclee",
      size: "50x70",
      frame: "brown",
      mount: "none",
    }).toString(),
    "format=giclee&size=50x70",
  );
  assert.equal(
    selectionToParams({
      format: "digital",
      size: "50x70",
      frame: "brown",
      mount: "none",
    }).toString(),
    "format=digital",
  );
});

test("serialise then parse round-trips every offered physical variation", () => {
  const physical = SELLABLE_FORMATS.filter((format) => format !== "digital");
  // Frame and mount are only encoded for framed, so a non-framed selection
  // round-trips at the defaults and a framed one at every finish and mount.
  const framesFor = (format: PrintSelection["format"]) =>
    format === "framed"
      ? (["black", "white", "brown"] as const)
      : ([DEFAULT_FRAME_FINISH] as const);
  const mountsFor = (format: PrintSelection["format"]) =>
    format === "framed" ? FRAMED_MOUNTS : ([DEFAULT_FRAMED_MOUNT] as const);

  for (const format of physical) {
    for (const size of OFFER[format]) {
      for (const frame of framesFor(format)) {
        for (const mount of mountsFor(format)) {
          const selection: PrintSelection = { format, size, frame, mount };
          assert.deepEqual(
            parse(selectionToParams(selection).toString()),
            selection,
          );
        }
      }
    }
  }
});

test("digital round-trips to its own default size and mount", () => {
  const selection: PrintSelection = {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
  };
  assert.deepEqual(parse(selectionToParams(selection).toString()), selection);
});

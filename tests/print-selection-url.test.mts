import assert from "node:assert/strict";
import test from "node:test";

import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_SIZE,
} from "../src/domain/ordering/print-copy.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";
import {
  selectionFromParams,
  selectionToParams,
} from "../src/domain/ordering/print-selection-url.ts";
import { SELLABLE_FORMATS } from "../src/domain/pricing/sku-map.ts";

const OFFER: PrintOffer = {
  giclee: ["30x40", "50x70"],
  framed: ["30x40", "50x70"],
  canvas: [],
};

function parse(query: string, offer: PrintOffer = OFFER): PrintSelection {
  return selectionFromParams(new URLSearchParams(query), offer);
}

test("a valid query reproduces that exact variation", () => {
  assert.deepEqual(parse("format=framed&size=50x70&frame=white"), {
    format: "framed",
    size: "50x70",
    frame: "white",
  });
  assert.deepEqual(parse("format=giclee&size=50x70"), {
    format: "giclee",
    size: "50x70",
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("absent params fall back to the photo's opening selection", () => {
  assert.deepEqual(parse(""), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("an unknown format falls back to the opening format", () => {
  assert.deepEqual(parse("format=poster"), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
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
  });
});

test("the size fallback follows the queried format, not the opening one", () => {
  // The opening format is giclee (first size 50x70); framed sells 30x40. A bare
  // `?format=framed` must open framed on framed's own first size, never the
  // opening format's, or the select points at a size framed does not sell.
  const split: PrintOffer = { giclee: ["50x70"], framed: ["30x40"], canvas: [] };
  assert.deepEqual(parse("format=framed", split), {
    format: "framed",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
  });
  // A size the queried format does not sell falls back to that format's first.
  assert.deepEqual(parse("format=framed&size=50x70", split), {
    format: "framed",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("a size is honoured for the opening format when format is absent", () => {
  assert.deepEqual(parse("size=50x70"), {
    format: "giclee",
    size: "50x70",
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("frame is only read for a framed selection", () => {
  assert.equal(parse("format=framed&frame=brown").frame, "brown");
  // An unknown finish falls back to the default.
  assert.equal(parse("format=framed&frame=chartreuse").frame, DEFAULT_FRAME_FINISH);
  // A frame on a non-framed format is ignored, not rejected.
  assert.equal(parse("format=giclee&frame=white").frame, DEFAULT_FRAME_FINISH);
});

test("digital ignores size and frame params", () => {
  assert.deepEqual(parse("format=digital&size=50x70&frame=white"), {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("a selection serialises to only the params its format has", () => {
  assert.equal(
    selectionToParams({ format: "framed", size: "30x40", frame: "white" }).toString(),
    "format=framed&size=30x40&frame=white",
  );
  assert.equal(
    selectionToParams({ format: "giclee", size: "50x70", frame: "brown" }).toString(),
    "format=giclee&size=50x70",
  );
  assert.equal(
    selectionToParams({ format: "digital", size: "50x70", frame: "brown" }).toString(),
    "format=digital",
  );
});

test("serialise then parse round-trips every offered physical variation", () => {
  const physical = SELLABLE_FORMATS.filter((format) => format !== "digital");
  // Frame is only encoded for framed, so a non-framed selection round-trips at
  // the default finish and a framed one at every finish.
  const framesFor = (format: PrintSelection["format"]) =>
    format === "framed"
      ? (["black", "white", "brown"] as const)
      : ([DEFAULT_FRAME_FINISH] as const);

  for (const format of physical) {
    for (const size of OFFER[format]) {
      for (const frame of framesFor(format)) {
        const selection: PrintSelection = { format, size, frame };
        assert.deepEqual(
          parse(selectionToParams(selection).toString()),
          selection,
        );
      }
    }
  }
});

test("digital round-trips to its own default size and frame", () => {
  const selection: PrintSelection = {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
  };
  assert.deepEqual(parse(selectionToParams(selection).toString()), selection);
});

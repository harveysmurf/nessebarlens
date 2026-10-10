import assert from "node:assert/strict";
import test from "node:test";

import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_SIZE,
} from "../src/domain/ordering/print-copy.ts";
import {
  openingSelection,
  withFormat,
  withFrame,
  withSize,
  type PrintSelection,
} from "../src/domain/ordering/print-selection.ts";

const OFFER: PrintOffer = {
  giclee: ["30x40", "50x70"],
  framed: ["30x40"],
  canvas: [],
};

test("openingSelection matches the configurator's opening behaviour", () => {
  // First offered format (giclee) and its first offered size; default frame.
  assert.deepEqual(openingSelection(OFFER), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
  });
  // A photo whose only physical format is framed opens on it.
  assert.deepEqual(
    openingSelection({ giclee: [], framed: ["50x70"], canvas: [] }),
    { format: "framed", size: "50x70", frame: DEFAULT_FRAME_FINISH },
  );
  // Nothing physical: digital is always offered, so the format is never absent.
  assert.deepEqual(openingSelection({ giclee: [], framed: [], canvas: [] }), {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
  });
});

test("withFormat re-picks the first offered size and keeps the frame", () => {
  const opening = openingSelection(OFFER);
  assert.deepEqual(withFormat(opening, OFFER, "framed"), {
    format: "framed",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
  });
  // The frame is preserved across a format change.
  const framedWhite: PrintSelection = { format: "framed", size: "30x40", frame: "white" };
  assert.deepEqual(withFormat(framedWhite, OFFER, "giclee"), {
    format: "giclee",
    size: "30x40",
    frame: "white",
  });
});

test("withFormat keeps the size for digital and for an empty format", () => {
  const sel: PrintSelection = { format: "giclee", size: "50x70", frame: "white" };
  // Digital carries no size, so size and frame are kept.
  assert.deepEqual(withFormat(sel, OFFER, "digital"), {
    format: "digital",
    size: "50x70",
    frame: "white",
  });
  // A physical format with nothing offered keeps the current size rather than
  // pointing the select at an option that is not in the list.
  assert.deepEqual(withFormat(sel, OFFER, "canvas"), {
    format: "canvas",
    size: "50x70",
    frame: "white",
  });
});

test("withSize and withFrame set exactly one field", () => {
  const sel: PrintSelection = { format: "giclee", size: "30x40", frame: "black" };
  assert.deepEqual(withSize(sel, "50x70"), {
    format: "giclee",
    size: "50x70",
    frame: "black",
  });
  assert.deepEqual(withFrame(sel, "brown"), {
    format: "giclee",
    size: "30x40",
    frame: "brown",
  });
});

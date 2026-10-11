import assert from "node:assert/strict";
import test from "node:test";

import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import {
  DEFAULT_FRAME_FINISH,
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_PAPER,
  DEFAULT_PRINT_SIZE,
} from "../src/domain/ordering/print-copy.ts";
import {
  openingSelection,
  withFormat,
  withFrame,
  withMount,
  withPaper,
  withSize,
  type PrintSelection,
} from "../src/domain/ordering/print-selection.ts";

const OFFER: PrintOffer = {
  giclee: ["30x40", "50x70"],
  framed: ["30x40"],
  canvas: [],
};

test("openingSelection matches the configurator's opening behaviour", () => {
  // First offered format (giclee) and its first offered size; default frame and
  // the default (mounted) framed mount.
  assert.deepEqual(openingSelection(OFFER), {
    format: "giclee",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
    paper: DEFAULT_PRINT_PAPER,
  });
  // A photo whose only physical format is framed opens on it.
  assert.deepEqual(
    openingSelection({ giclee: [], framed: ["50x70"], canvas: [] }),
    {
      format: "framed",
      size: "50x70",
      frame: DEFAULT_FRAME_FINISH,
      mount: DEFAULT_FRAMED_MOUNT,
      paper: DEFAULT_PRINT_PAPER,
    },
  );
  // Nothing physical: digital is always offered, so the format is never absent.
  assert.deepEqual(openingSelection({ giclee: [], framed: [], canvas: [] }), {
    format: "digital",
    size: DEFAULT_PRINT_SIZE,
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
    paper: DEFAULT_PRINT_PAPER,
  });
});

test("withFormat re-picks the first offered size and keeps the frame and mount", () => {
  const opening = openingSelection(OFFER);
  assert.deepEqual(withFormat(opening, OFFER, "framed"), {
    format: "framed",
    size: "30x40",
    frame: DEFAULT_FRAME_FINISH,
    mount: DEFAULT_FRAMED_MOUNT,
    paper: DEFAULT_PRINT_PAPER,
  });
  // The frame is preserved across a format change.
  const framedWhite: PrintSelection = {
    format: "framed",
    size: "30x40",
    frame: "white",
    mount: "none",
    paper: DEFAULT_PRINT_PAPER,
  };
  assert.deepEqual(withFormat(framedWhite, OFFER, "giclee"), {
    format: "giclee",
    size: "30x40",
    frame: "white",
    mount: "none",
    paper: DEFAULT_PRINT_PAPER,
  });
  // The paper is preserved across a format change too.
  assert.deepEqual(
    withFormat({ ...framedWhite, paper: "hpr" }, OFFER, "giclee"),
    {
      format: "giclee",
      size: "30x40",
      frame: "white",
      mount: "none",
      paper: "hpr",
    },
  );
});

test("withFormat keeps the size for digital and for an empty format", () => {
  const sel: PrintSelection = {
    format: "giclee",
    size: "50x70",
    frame: "white",
    mount: "white",
    paper: "hpr",
  };
  // Digital carries no size, so size and frame are kept.
  assert.deepEqual(withFormat(sel, OFFER, "digital"), {
    format: "digital",
    size: "50x70",
    frame: "white",
    mount: "white",
    paper: "hpr",
  });
  // A physical format with nothing offered keeps the current size rather than
  // pointing the select at an option that is not in the list.
  assert.deepEqual(withFormat(sel, OFFER, "canvas"), {
    format: "canvas",
    size: "50x70",
    frame: "white",
    mount: "white",
    paper: "hpr",
  });
});

test("withSize, withFrame, withMount and withPaper set exactly one field", () => {
  const sel: PrintSelection = {
    format: "framed",
    size: "30x40",
    frame: "black",
    mount: "white",
    paper: "ema",
  };
  assert.deepEqual(withSize(sel, "50x70"), {
    format: "framed",
    size: "50x70",
    frame: "black",
    mount: "white",
    paper: "ema",
  });
  assert.deepEqual(withFrame(sel, "brown"), {
    format: "framed",
    size: "30x40",
    frame: "brown",
    mount: "white",
    paper: "ema",
  });
  assert.deepEqual(withMount(sel, "none"), {
    format: "framed",
    size: "30x40",
    frame: "black",
    mount: "none",
    paper: "ema",
  });
  assert.deepEqual(withPaper(sel, "hpr"), {
    format: "framed",
    size: "30x40",
    frame: "black",
    mount: "white",
    paper: "hpr",
  });
});

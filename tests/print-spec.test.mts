import assert from "node:assert/strict";
import test from "node:test";
import {
  frameForFormat,
  mountForFormat,
  paperForFormat,
  parsePrintSpecification,
  physicalSpecification,
} from "../src/domain/ordering/print-spec.ts";
import {
  FRAME_FINISHES,
  FRAMED_MOUNTS,
  PRINT_PAPERS,
  PRINT_SIZES,
} from "../src/domain/pricing/sku-map.ts";

test("digital accepts an empty selection and refuses a filled one", () => {
  for (const [size, frame] of [
    [null, null],
    [undefined, undefined],
  ] as const) {
    assert.deepEqual(
      parsePrintSpecification("digital", size, frame, null, null),
      {
        ok: true,
        value: { kind: "digital" },
      },
    );
  }
  assert.deepEqual(parsePrintSpecification("digital", "30x40", null, null, null), {
    ok: false,
    reason: "digital-rejects-size",
  });
  assert.deepEqual(parsePrintSpecification("digital", "", null, null, null), {
    ok: false,
    reason: "digital-rejects-size",
  });
  assert.deepEqual(
    parsePrintSpecification("digital", null, "black", null, null),
    {
      ok: false,
      reason: "digital-rejects-frame",
    },
  );
  assert.deepEqual(
    parsePrintSpecification("digital", null, false, null, null),
    {
      ok: false,
      reason: "digital-rejects-frame",
    },
  );
  assert.deepEqual(
    parsePrintSpecification("digital", null, null, "white", null),
    {
      ok: false,
      reason: "digital-rejects-mount",
    },
  );
  assert.deepEqual(
    parsePrintSpecification("digital", null, null, null, "ema"),
    {
      ok: false,
      reason: "digital-rejects-paper",
    },
  );
});

test("a physical format always needs a size from the print list", () => {
  for (const size of [undefined, null, "", "99x99", 7]) {
    assert.deepEqual(
      parsePrintSpecification("giclee", size, null, null, null),
      { ok: false, reason: "size-required" },
      String(size),
    );
  }
  for (const size of PRINT_SIZES) {
    assert.deepEqual(
      parsePrintSpecification("giclee", size, null, null, null),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "giclee",
          size,
          frame: null,
          mount: null,
          paper: "ema",
        },
      },
      size,
    );
  }
});

test("giclee honours a known paper, defaults an absent one, and refuses an unknown one", () => {
  for (const paper of PRINT_PAPERS) {
    assert.deepEqual(
      parsePrintSpecification("giclee", "50x70", null, null, paper),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "giclee",
          size: "50x70",
          frame: null,
          mount: null,
          paper,
        },
      },
      paper,
    );
  }
  // An absent paper reads as the default, so a pre-#337 body still resolves.
  for (const paper of [undefined, null]) {
    assert.deepEqual(
      parsePrintSpecification("giclee", "50x70", null, null, paper),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "giclee",
          size: "50x70",
          frame: null,
          mount: null,
          paper: "ema",
        },
      },
      String(paper),
    );
  }
  // A present-but-unknown paper is refused with its own reason rather than
  // silently swapped to the default — a different product at a different price.
  for (const paper of ["vellum", 7]) {
    assert.deepEqual(
      parsePrintSpecification("giclee", "50x70", null, null, paper),
      { ok: false, reason: "paper-invalid" },
      String(paper),
    );
  }
});

test("framed carries a known finish and defaults its mount to the mounted one", () => {
  for (const frame of FRAME_FINISHES) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", frame, null, null),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "framed",
          size: "50x70",
          frame,
          mount: "white",
          paper: null,
        },
      },
      frame,
    );
  }
  for (const frame of [undefined, null, "", "gold", 7]) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", frame, null, null),
      { ok: false, reason: "frame-required" },
      String(frame),
    );
  }
});

test("framed honours a known mount, defaults an absent one, and refuses an unknown one", () => {
  for (const mount of FRAMED_MOUNTS) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", "black", mount, null),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "framed",
          size: "50x70",
          frame: "black",
          mount,
          paper: null,
        },
      },
      mount,
    );
  }
  // An absent mount reads as the default, so a pre-#335 body still resolves
  // rather than being refused.
  for (const mount of [undefined, null]) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", "black", mount, null),
      {
        ok: true,
        value: {
          kind: "physical",
          format: "framed",
          size: "50x70",
          frame: "black",
          mount: "white",
          paper: null,
        },
      },
      String(mount),
    );
  }
  // A present-but-unknown mount is refused with its own reason rather than
  // silently swapped to the default: "sandwich" would otherwise become a White
  // Mount at a different price, which is the silent swap this rule forbids.
  for (const mount of ["sandwich", 7]) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", "black", mount, null),
      { ok: false, reason: "mount-invalid" },
      String(mount),
    );
  }
});

test("the other physical formats refuse a finish, mount or paper rather than drop it", () => {
  for (const format of ["giclee", "canvas"] as const) {
    for (const frame of [null, undefined]) {
      assert.deepEqual(
        parsePrintSpecification(format, "30x40", frame, null, null),
        {
          ok: true,
          value: {
            kind: "physical",
            format,
            size: "30x40",
            frame: null,
            mount: null,
            paper: format === "giclee" ? "ema" : null,
          },
        },
        `${format} with ${String(frame)}`,
      );
    }
    assert.deepEqual(
      parsePrintSpecification(format, "30x40", "black", null, null),
      { ok: false, reason: "frame-not-allowed" },
      format,
    );
    assert.deepEqual(
      parsePrintSpecification(format, "30x40", null, "none", null),
      { ok: false, reason: "mount-not-allowed" },
      format,
    );
  }
  // A paper is refused on canvas (framed is covered above and never carries
  // one); giclée is the one format that accepts it, tested separately.
  assert.deepEqual(
    parsePrintSpecification("canvas", "30x40", null, null, "hpr"),
    { ok: false, reason: "paper-not-allowed" },
  );
});

test("a size offered only by another format is refused with its own reason", () => {
  // The pinned table contains every pair, so the branch is unreachable from the
  // real catalogue; the injected table is what proves it. Giclée offers no
  // 70x100 here, so it is the pair — not the size — that is refused.
  const table = [
    {
      format: "giclee",
      size: "30x40",
      sizeIn: "12x16",
      paper: "ema",
      sku: "GLOBAL-FAP-12X16",
      printAreaPx: { short: 3600, long: 4800 },
      printAreaDpi: 300,
    },
  ] as const;
  assert.deepEqual(
    parsePrintSpecification("giclee", "70x100", null, null, null, table),
    { ok: false, reason: "size-not-offered-for-format" },
  );
  assert.deepEqual(
    parsePrintSpecification("giclee", "30x40", null, null, null, table),
    {
      ok: true,
      value: {
        kind: "physical",
        format: "giclee",
        size: "30x40",
        frame: null,
        mount: null,
        paper: "ema",
      },
    },
  );
});

test("a physical format yields a physical result, without a second check", () => {
  // The overload's contract: a caller that has already proved its format
  // physical reads the physical arm straight off the result.
  const result = parsePrintSpecification("canvas", "70x100", null, null, null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.kind, "physical");
});

test("frame, mount and paper projections carry each only with their format", () => {
  assert.equal(frameForFormat("framed", "brown"), "brown");
  assert.equal(frameForFormat("framed", null), null);
  for (const format of ["giclee", "canvas", "digital"] as const) {
    assert.equal(frameForFormat(format, "black"), null, format);
  }
  assert.equal(mountForFormat("framed", "none"), "none");
  // Absent reads as the default; non-framed carries none.
  assert.equal(mountForFormat("framed", null), "white");
  for (const format of ["giclee", "canvas", "digital"] as const) {
    assert.equal(mountForFormat(format, "none"), null, format);
  }
  assert.equal(paperForFormat("giclee", "hpr"), "hpr");
  // Absent reads as the default; non-giclée carries none.
  assert.equal(paperForFormat("giclee", null), "ema");
  for (const format of ["framed", "canvas", "digital"] as const) {
    assert.equal(paperForFormat(format, "hpr"), null, format);
  }
});

test("physicalSpecification normalises into a selection the factory accepts", () => {
  assert.deepEqual(
    physicalSpecification("giclee", "30x40", "black", null, null),
    {
      kind: "physical",
      format: "giclee",
      size: "30x40",
      frame: null,
      mount: null,
      paper: "ema",
    },
  );
  assert.deepEqual(
    physicalSpecification("giclee", "30x40", null, null, "hpr"),
    {
      kind: "physical",
      format: "giclee",
      size: "30x40",
      frame: null,
      mount: null,
      paper: "hpr",
    },
  );
  assert.deepEqual(
    physicalSpecification("framed", "50x70", "white", "none", null),
    {
      kind: "physical",
      format: "framed",
      size: "50x70",
      frame: "white",
      mount: "none",
      paper: null,
    },
  );
  // Round-trip, not just shape: the normalised selection has to be one the
  // factory takes, or the client would still be forwarding a refusal.
  for (const format of ["giclee", "framed", "canvas"] as const) {
    for (const paper of PRINT_PAPERS) {
      const spec = physicalSpecification(
        format,
        "70x100",
        "black",
        "none",
        paper,
      );
      assert.deepEqual(
        parsePrintSpecification(
          spec.format,
          spec.size,
          spec.frame,
          spec.mount,
          spec.paper,
        ),
        { ok: true, value: spec },
        `${format}/${paper}`,
      );
    }
  }
});

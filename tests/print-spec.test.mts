import assert from "node:assert/strict";
import test from "node:test";
import {
  frameForFormat,
  parsePrintSpecification,
  physicalSpecification,
} from "../src/domain/ordering/print-spec.ts";
import { FRAME_FINISHES, PRINT_SIZES } from "../src/domain/pricing/sku-map.ts";

test("digital accepts an empty selection and refuses a filled one", () => {
  for (const [size, frame] of [
    [null, null],
    [undefined, undefined],
  ] as const) {
    assert.deepEqual(parsePrintSpecification("digital", size, frame), {
      ok: true,
      value: { kind: "digital" },
    });
  }
  assert.deepEqual(parsePrintSpecification("digital", "30x40", null), {
    ok: false,
    reason: "digital-rejects-size",
  });
  assert.deepEqual(parsePrintSpecification("digital", "", null), {
    ok: false,
    reason: "digital-rejects-size",
  });
  assert.deepEqual(parsePrintSpecification("digital", null, "black"), {
    ok: false,
    reason: "digital-rejects-frame",
  });
  assert.deepEqual(parsePrintSpecification("digital", null, false), {
    ok: false,
    reason: "digital-rejects-frame",
  });
});

test("a physical format always needs a size from the print list", () => {
  for (const size of [undefined, null, "", "99x99", 7]) {
    assert.deepEqual(
      parsePrintSpecification("giclee", size, null),
      { ok: false, reason: "size-required" },
      String(size),
    );
  }
  for (const size of PRINT_SIZES) {
    assert.deepEqual(
      parsePrintSpecification("giclee", size, null),
      { ok: true, value: { kind: "physical", format: "giclee", size, frame: null } },
      size,
    );
  }
});

test("framed carries a known finish, and nothing else does", () => {
  for (const frame of FRAME_FINISHES) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", frame),
      {
        ok: true,
        value: { kind: "physical", format: "framed", size: "50x70", frame },
      },
      frame,
    );
  }
  for (const frame of [undefined, null, "", "gold", 7]) {
    assert.deepEqual(
      parsePrintSpecification("framed", "50x70", frame),
      { ok: false, reason: "frame-required" },
      String(frame),
    );
  }
});

test("the other physical formats refuse a finish rather than drop it", () => {
  for (const format of ["giclee", "canvas"] as const) {
    for (const frame of [null, undefined]) {
      assert.deepEqual(
        parsePrintSpecification(format, "30x40", frame),
        {
          ok: true,
          value: { kind: "physical", format, size: "30x40", frame: null },
        },
        `${format} with ${String(frame)}`,
      );
    }
    assert.deepEqual(
      parsePrintSpecification(format, "30x40", "black"),
      { ok: false, reason: "frame-not-allowed" },
      format,
    );
  }
});

test("a size offered only by another format is refused with its own reason", () => {
  // The pinned nine contain every pair, so the branch is unreachable from the
  // real catalogue; the injected table is what proves it. Giclée offers no
  // 70x100 here, so it is the pair — not the size — that is refused.
  const table = [
    {
      format: "giclee",
      size: "30x40",
      sizeIn: "12x16",
      sku: "GLOBAL-FAP-12X16",
      printAreaPx: { short: 3600, long: 4800 },
      printAreaDpi: 300,
    },
  ] as const;
  assert.deepEqual(
    parsePrintSpecification("giclee", "70x100", null, table),
    { ok: false, reason: "size-not-offered-for-format" },
  );
  assert.deepEqual(
    parsePrintSpecification("giclee", "30x40", null, table),
    {
      ok: true,
      value: { kind: "physical", format: "giclee", size: "30x40", frame: null },
    },
  );
});

test("a physical format yields a physical result, without a second check", () => {
  // The overload's contract: a caller that has already proved its format
  // physical reads the physical arm straight off the result.
  const result = parsePrintSpecification("canvas", "70x100", null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.kind, "physical");
});

test("the frame projection carries the finish only with framed", () => {
  assert.equal(frameForFormat("framed", "brown"), "brown");
  assert.equal(frameForFormat("framed", null), null);
  for (const format of ["giclee", "canvas", "digital"] as const) {
    assert.equal(frameForFormat(format, "black"), null, format);
  }
});

test("physicalSpecification normalises into a selection the factory accepts", () => {
  assert.deepEqual(physicalSpecification("giclee", "30x40", "black"), {
    kind: "physical",
    format: "giclee",
    size: "30x40",
    frame: null,
  });
  assert.deepEqual(physicalSpecification("framed", "50x70", "white"), {
    kind: "physical",
    format: "framed",
    size: "50x70",
    frame: "white",
  });
  // Round-trip, not just shape: the normalised selection has to be one the
  // factory takes, or the client would still be forwarding a refusal.
  for (const format of ["giclee", "framed", "canvas"] as const) {
    const spec = physicalSpecification(format, "70x100", "black");
    assert.deepEqual(
      parsePrintSpecification(spec.format, spec.size, spec.frame),
      { ok: true, value: spec },
      format,
    );
  }
});

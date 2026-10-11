import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PRODIGI_SHIPPING_METHOD } from "../src/infrastructure/prodigi/prodigi-config.ts";
import type { FrameFinish, PrintSize } from "../src/domain/pricing/pricing.ts";
import type { FramedMount, PrintPaper } from "../src/domain/pricing/sku-map.ts";
import {
  CANVAS_WRAP,
  FRAME_COLOR,
  FRAME_FINISHES,
  FRAMED_MOUNTS,
  PHYSICAL_FORMATS,
  PINNED_SKUS,
  PRINT_PAPERS,
  PRINT_SIZES,
  SIZE_TO_INCH,
  allPhysicalSkus,
  isFrameFinishValue,
  isFramedMountValue,
  isPhysicalFormat,
  isPrintPaperValue,
  isPrintSize,
  isSellableFormat,
  resolveSku,
} from "../src/domain/pricing/sku-map.ts";

test("every UI format×size (and framed mount, giclée paper) resolves to a pinned SKU", () => {
  const resolved = new Set<string>();
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      const mounts: (FramedMount | null)[] =
        format === "framed" ? [...FRAMED_MOUNTS] : [null];
      const papers: (PrintPaper | null)[] =
        format === "giclee" ? [...PRINT_PAPERS] : [null];
      for (const mount of mounts) {
        for (const paper of papers) {
          const entry = resolveSku(
            format,
            size,
            format === "framed" ? "black" : null,
            mount,
            paper,
          );
          assert.ok(
            (PINNED_SKUS as readonly string[]).includes(entry.sku),
            `${format}/${size}/${mount}/${paper} → ${entry.sku} not in PINNED_SKUS`,
          );
          assert.equal(entry.sizeCm, size);
          assert.equal(entry.sizeIn, SIZE_TO_INCH[size]);
          resolved.add(entry.sku);
        }
      }
    }
  }
  assert.equal(resolved.size, 40);
  assert.deepEqual([...resolved].sort(), [...PINNED_SKUS].sort());
});

test("a framed mount picks CFPM (white) or CFP (none)", () => {
  assert.equal(resolveSku("framed", "50x70", "black", "white", null).sku, "GLOBAL-CFPM-20X28");
  assert.equal(resolveSku("framed", "50x70", "black", "none", null).sku, "GLOBAL-CFP-20X28");
  // A null mount is the default, so a pre-#335 caller that passes null is
  // unchanged. (The mount is required since #335 so this cannot be omitted.)
  assert.equal(resolveSku("framed", "50x70", "black", null, null).sku, "GLOBAL-CFPM-20X28");
  assert.equal(isFramedMountValue("none"), true);
  assert.equal(isFramedMountValue("gold"), false);
});

test("a giclée paper picks FAP (ema) or HPR (hpr)", () => {
  assert.equal(resolveSku("giclee", "50x70", null, null, "ema").sku, "GLOBAL-FAP-20X28");
  assert.equal(resolveSku("giclee", "50x70", null, null, "hpr").sku, "GLOBAL-HPR-20X28");
  // A null paper is the default (Matte Art), so a pre-#337 caller is unchanged.
  assert.equal(resolveSku("giclee", "50x70", null, null, null).sku, "GLOBAL-FAP-20X28");
  assert.equal(isPrintPaperValue("hpr"), true);
  assert.equal(isPrintPaperValue("vellum"), false);
});

test("allPhysicalSkus returns exactly the 40 pinned SKUs", () => {
  const entries = allPhysicalSkus();
  assert.equal(entries.length, 40);
  assert.deepEqual(
    entries.map((e) => e.sku).sort(),
    [...PINNED_SKUS].sort(),
  );
});

test("resolveSku refuses a pair the table does not offer", () => {
  // Typed callers only pass pairs the table defines, so this guard is the
  // backstop for a format-specific catalogue that dropped a size: without it a
  // missing pair would resolve to another product's SKU rather than fail.
  assert.throws(
    () => resolveSku("giclee", "99x99" as PrintSize, null, null, null),
    /no print product for giclee\/99x99/,
  );
});

test("framed requires a frame color; giclee/canvas reject needing color", () => {
  assert.throws(() => resolveSku("framed", "30x40", null, null, null), /frame required/);
  for (const finish of FRAME_FINISHES) {
    const entry = resolveSku("framed", "50x70", finish, null, null);
    assert.equal(entry.sku, "GLOBAL-CFPM-20X28");
    assert.equal(entry.attributes.color, finish);
  }
  const giclee = resolveSku("giclee", "70x100", null, null, null);
  assert.equal(giclee.sku, "GLOBAL-FAP-28X40");
  assert.deepEqual(giclee.attributes, {});
  const canvas = resolveSku("canvas", "30x40", null, null, null);
  assert.equal(canvas.sku, "GLOBAL-CAN-12X16");
  // Prodigi rejects a CAN quote with 400 MissingRequiredAttributes unless `wrap`
  // is present, so this is not decorative: an empty map means canvas never quotes.
  assert.deepEqual(canvas.attributes, { wrap: CANVAS_WRAP });
});

test("every canvas SKU carries the required wrap attribute", () => {
  // Asserted per-format rather than on one entry because the defect was in the
  // format branch: a single resolveSku("canvas", ...) would have passed while
  // some other size drifted. Prodigi validates per SKU, so all three must hold.
  for (const size of PRINT_SIZES) {
    const entry = resolveSku("canvas", size, null, null, null);
    assert.equal(entry.attributes.wrap, CANVAS_WRAP, `${entry.sku} has no wrap`);
  }
});

test("SKU table: format / cm / in / sku", () => {
  // [format, paper, cm, in, sku] — paper is null for every non-giclée row.
  const table = [
    ["giclee", "ema", "20x30", "8x12", "GLOBAL-FAP-8X12"],
    ["giclee", "ema", "30x40", "12x16", "GLOBAL-FAP-12X16"],
    ["giclee", "ema", "30x45", "12x18", "GLOBAL-FAP-12X18"],
    ["giclee", "ema", "40x60", "16x24", "GLOBAL-FAP-16X24"],
    ["giclee", "ema", "50x70", "20x28", "GLOBAL-FAP-20X28"],
    ["giclee", "ema", "50x75", "20x30", "GLOBAL-FAP-20X30"],
    ["giclee", "ema", "60x90", "24x36", "GLOBAL-FAP-24X36"],
    ["giclee", "ema", "70x100", "28x40", "GLOBAL-FAP-28X40"],
    ["giclee", "hpr", "20x30", "8x12", "GLOBAL-HPR-8X12"],
    ["giclee", "hpr", "30x40", "12x16", "GLOBAL-HPR-12X16"],
    ["giclee", "hpr", "30x45", "12x18", "GLOBAL-HPR-12X18"],
    ["giclee", "hpr", "40x60", "16x24", "GLOBAL-HPR-16X24"],
    ["giclee", "hpr", "50x70", "20x28", "GLOBAL-HPR-20X28"],
    ["giclee", "hpr", "50x75", "20x30", "GLOBAL-HPR-20X30"],
    ["giclee", "hpr", "60x90", "24x36", "GLOBAL-HPR-24X36"],
    ["giclee", "hpr", "70x100", "28x40", "GLOBAL-HPR-28X40"],
    ["framed", null, "20x30", "8x12", "GLOBAL-CFPM-8X12"],
    ["framed", null, "30x40", "12x16", "GLOBAL-CFPM-12X16"],
    ["framed", null, "30x45", "12x18", "GLOBAL-CFPM-12X18"],
    ["framed", null, "40x60", "16x24", "GLOBAL-CFPM-16X24"],
    ["framed", null, "50x70", "20x28", "GLOBAL-CFPM-20X28"],
    ["framed", null, "50x75", "20x30", "GLOBAL-CFPM-20X30"],
    ["framed", null, "60x90", "24x36", "GLOBAL-CFPM-24X36"],
    ["framed", null, "70x100", "28x40", "GLOBAL-CFPM-28X40"],
    ["canvas", null, "20x30", "8x12", "GLOBAL-CAN-8X12"],
    ["canvas", null, "30x40", "12x16", "GLOBAL-CAN-12X16"],
    ["canvas", null, "30x45", "12x18", "GLOBAL-CAN-12X18"],
    ["canvas", null, "40x60", "16x24", "GLOBAL-CAN-16X24"],
    ["canvas", null, "50x70", "20x28", "GLOBAL-CAN-20X28"],
    ["canvas", null, "50x75", "20x30", "GLOBAL-CAN-20X30"],
    ["canvas", null, "60x90", "24x36", "GLOBAL-CAN-24X36"],
    ["canvas", null, "70x100", "28x40", "GLOBAL-CAN-28X40"],
  ] as const;
  for (const [format, paper, cm, inch, sku] of table) {
    const entry = resolveSku(
      format,
      cm,
      format === "framed" ? "brown" : null,
      null,
      paper,
    );
    assert.equal(entry.sku, sku);
    assert.equal(entry.sizeIn, inch);
  }
});

test("PINNED_SKUS is derived: complete, unique, and in catalog order", () => {
  assert.deepEqual(
    [...PINNED_SKUS],
    allPhysicalSkus().map((entry) => entry.sku),
  );
  assert.equal(new Set(PINNED_SKUS).size, PINNED_SKUS.length);
  // Every format × size, plus one extra line per second framed mount (#335) and
  // per second giclée paper (#337).
  assert.equal(
    PINNED_SKUS.length,
    PHYSICAL_FORMATS.length * PRINT_SIZES.length +
      (FRAMED_MOUNTS.length - 1) * PRINT_SIZES.length +
      (PRINT_PAPERS.length - 1) * PRINT_SIZES.length,
  );
});

test("every pinned SKU matches the GLOBAL-<PREFIX>-<W>H<H> shape", () => {
  assert.equal(
    PINNED_SKUS.every((sku) => /^GLOBAL-[A-Z]+-\d+X\d+$/.test(sku)),
    true,
  );
  assert.equal(
    PINNED_SKUS.every((sku) => PRINT_SIZES.some((size) => sku.endsWith(`-${SIZE_TO_INCH[size].toUpperCase()}`))),
    true,
  );
});

test("FRAME_FINISHES is the FRAME_COLOR key set, not a second hand-written list", () => {
  // A finish added to one list and not the other used to compile fine and
  // then fail at order time.
  assert.deepEqual(FRAME_FINISHES, Object.keys(FRAME_COLOR));
  assert.equal(new Set(FRAME_FINISHES).size, FRAME_FINISHES.length);
  for (const finish of FRAME_FINISHES) {
    assert.equal(FRAME_COLOR[finish as FrameFinish], finish);
  }
});

test("the missing-frame error lists the finishes resolveSku actually accepts", () => {
  assert.throws(
    () => resolveSku("framed", "30x40", null, null, null),
    new RegExp(`frame required .*\\(${FRAME_FINISHES.join("\\|")}\\)`),
  );
  assert.throws(
    () => resolveSku("framed", "30x40", "gold" as FrameFinish, null, null),
    /frame required/,
  );
});

test("isPhysicalFormat rejects digital; isSellableFormat accepts it", () => {
  assert.equal(isPhysicalFormat("digital"), false);
  assert.equal(isSellableFormat("digital"), true);
  for (const format of PHYSICAL_FORMATS) {
    assert.equal(isPhysicalFormat(format), true);
    assert.equal(isSellableFormat(format), true);
  }
  assert.equal(isPhysicalFormat(null), false);
  assert.equal(isPhysicalFormat("poster"), false);
  assert.equal(isPrintSize("30x40"), true);
  assert.equal(isPrintSize("40x30"), false);
  assert.equal(isFrameFinishValue("black"), true);
  assert.equal(isFrameFinishValue("gold"), false);
  assert.equal(isPrintPaperValue("ema"), true);
  assert.equal(isPrintPaperValue("hpr"), true);
  assert.equal(isPrintPaperValue("vellum"), false);
});

test("the Prodigi shipping method is declared once, in prodigi-config", () => {
  // Quote and order must buy and charge for the same shipping. The value was
  // a literal in both bodies and in the request type, so a divergence would
  // have been invisible to every test here. Both now read this constant.
  assert.equal(PRODIGI_SHIPPING_METHOD, "Budget");
  for (const file of [
    "../src/infrastructure/prodigi/prodigi-quote.ts",
    "../src/infrastructure/prodigi/prodigi-order.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !source.includes('"Budget"'),
      `${file} re-spells the shipping method literal`,
    );
  }
});

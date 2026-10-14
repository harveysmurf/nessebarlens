/**
 * The pinned print product table: the one place a sellable (format, size)
 * pair, its Prodigi SKU and its real print area are written down.
 *
 * Print areas are the mount window for a framed print and the area including
 * the wrap for a canvas; #291's effective-PPI maths consumes them. They come
 * from Prodigi product details, captured into tests/fixtures/prodigi/products.json
 * by scripts/capture-prodigi-products.mjs and checked here by
 * tests/print-products-fixture.test.mts. A drifted Prodigi catalogue then shows
 * up as a fixture diff in a reviewed PR instead of a silently wrong number.
 *
 * Stored as an unordered `{ short, long }` pair, so orientation — which is the
 * photo's, not the product's — never enters the table.
 *
 * Pure: no imports that reach an effect, so it can be loaded by the ops scripts
 * and the test runner alike.
 */

import type { PhysicalFormat } from "./sku-map";

/**
 * The mount a framed product ships with (#335). It is part of the product key,
 * not a request attribute: Prodigi sells the mounted and unmounted frames as
 * separate SKUs (GLOBAL-CFPM-* vs GLOBAL-CFP-*), and the print area differs
 * (the mount window vs the full glaze). Adding a mount is a compile error here
 * until its SKUs are in the table, the same rule the format and size columns
 * follow.
 */
export type FramedMount = "white" | "none";

/** The mounts we offer, in the order the configurator shows them. */
export const FRAMED_MOUNTS: readonly FramedMount[] = ["white", "none"];

/** The mount the configurator opens on and old orders without one read as. */
export const DEFAULT_FRAMED_MOUNT: FramedMount = "white";

/**
 * The paper a giclée product is printed on (#337). Like the mount, it is part
 * of the product key, not a request attribute: Prodigi sells the two papers as
 * separate SKUs (GLOBAL-FAP-* vs GLOBAL-HPR-*), at different prices, so adding
 * one is a compile error here until its SKUs are in the table.
 *
 * `ema` is Prodigi's Enhanced Matte Art 200gsm (what every giclée shipped
 * before #337); `hpr` is Hahnemühle Photo Rag 308gsm. Only giclée carries it.
 */
export type PrintPaper = "ema" | "hpr";

/** The papers we offer, in the order the configurator shows them. */
export const PRINT_PAPERS: readonly PrintPaper[] = ["ema", "hpr"];

/** The paper the configurator opens on and old orders without one read as. */
export const DEFAULT_PRINT_PAPER: PrintPaper = "ema";

type PrintProductBase = {
  /** Centimetres, e.g. "30x40". */
  size: string;
  /** Prodigi's inchsuffix, e.g. "12x16". */
  sizeIn: string;
  sku: string;
  printAreaPx: { short: number; long: number };
  /** Prodigi's catalogue resolution standard for these products. */
  printAreaDpi: number;
};

/** A framed product carries its mount, which the other formats have not got. */
export type FramedProductEntry = PrintProductBase & {
  format: "framed";
  mount: FramedMount;
};

/** A giclée product carries its paper, which the other formats have not got. */
export type GicleeProductEntry = PrintProductBase & {
  format: "giclee";
  paper: PrintPaper;
};

export type PrintProductEntry =
  | FramedProductEntry
  | GicleeProductEntry
  | (PrintProductBase & { format: Exclude<PhysicalFormat, "framed" | "giclee"> });

export const PRINT_PRODUCTS = [
  // 2:3 sizes (#303) sit alongside the 3:4 and 5:7 ones, ordered small to large
  // by area within each format. The 2:3 SKUs are the cm-nominal IDs: 20x30 =
  // 8x12", 30x45 = 12x18", 40x60 = 16x24", 50x75 = 20x30", 60x90 = 24x36".
  { format: "giclee", size: "20x30", sizeIn: "8x12", paper: "ema", sku: "GLOBAL-FAP-8X12", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x40", sizeIn: "12x16", paper: "ema", sku: "GLOBAL-FAP-12X16", printAreaPx: { short: 3600, long: 4800 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x45", sizeIn: "12x18", paper: "ema", sku: "GLOBAL-FAP-12X18", printAreaPx: { short: 3600, long: 5400 }, printAreaDpi: 300 },
  { format: "giclee", size: "40x60", sizeIn: "16x24", paper: "ema", sku: "GLOBAL-FAP-16X24", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x70", sizeIn: "20x28", paper: "ema", sku: "GLOBAL-FAP-20X28", printAreaPx: { short: 6000, long: 8400 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x75", sizeIn: "20x30", paper: "ema", sku: "GLOBAL-FAP-20X30", printAreaPx: { short: 6000, long: 9000 }, printAreaDpi: 300 },
  { format: "giclee", size: "60x90", sizeIn: "24x36", paper: "ema", sku: "GLOBAL-FAP-24X36", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "giclee", size: "70x100", sizeIn: "28x40", paper: "ema", sku: "GLOBAL-FAP-28X40", printAreaPx: { short: 8400, long: 12000 }, printAreaDpi: 300 },
  // Hahnemühle Photo Rag 308gsm (#337), same eight sizes. Prodigi's captured
  // print areas are identical to the FAP ones at every size (verified
  // 2026-10-10, and the fixture test proves it), so PPI eligibility and the
  // preview geometry do not change — only the SKU, the price and the copy do.
  // Listed after the Matte Art block, size by size, so `findProduct` with no
  // paper returns the default and `isOfferedProduct` keeps the offer to one
  // line per size.
  { format: "giclee", size: "20x30", sizeIn: "8x12", paper: "hpr", sku: "GLOBAL-HPR-8X12", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x40", sizeIn: "12x16", paper: "hpr", sku: "GLOBAL-HPR-12X16", printAreaPx: { short: 3600, long: 4800 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x45", sizeIn: "12x18", paper: "hpr", sku: "GLOBAL-HPR-12X18", printAreaPx: { short: 3600, long: 5400 }, printAreaDpi: 300 },
  { format: "giclee", size: "40x60", sizeIn: "16x24", paper: "hpr", sku: "GLOBAL-HPR-16X24", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x70", sizeIn: "20x28", paper: "hpr", sku: "GLOBAL-HPR-20X28", printAreaPx: { short: 6000, long: 8400 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x75", sizeIn: "20x30", paper: "hpr", sku: "GLOBAL-HPR-20X30", printAreaPx: { short: 6000, long: 9000 }, printAreaDpi: 300 },
  { format: "giclee", size: "60x90", sizeIn: "24x36", paper: "hpr", sku: "GLOBAL-HPR-24X36", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "giclee", size: "70x100", sizeIn: "28x40", paper: "hpr", sku: "GLOBAL-HPR-28X40", printAreaPx: { short: 8400, long: 12000 }, printAreaDpi: 300 },
  // Framed prints come in two mounts (#335): CFPM ships with a snow-white
  // mount, CFP is unmounted and the photo fills the whole glaze. The mount is
  // part of the key, so both run through the same table. Listed mounted first,
  // size by size, so `findProduct` with no mount returns the default.
  { format: "framed", mount: "white", size: "20x30", sizeIn: "8x12", sku: "GLOBAL-CFPM-8X12", printAreaPx: { short: 1800, long: 3000 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "20x30", sizeIn: "8x12", sku: "GLOBAL-CFP-8X12", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-CFPM-12X16", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  // CFPM-12X16's mount window is 2400×3600; the unmounted CFP area is the full
  // glaze. Prodigi reports 3614×4795 for black/white but 3600×4800 for the other
  // colours, so the table stores the safe minimum across colours (3600×4795):
  // the resolution maths then never over-estimates the area it is printing into.
  { format: "framed", mount: "none", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-CFP-12X16", printAreaPx: { short: 3600, long: 4795 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "30x45", sizeIn: "12x18", sku: "GLOBAL-CFPM-12X18", printAreaPx: { short: 2418, long: 4218 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "30x45", sizeIn: "12x18", sku: "GLOBAL-CFP-12X18", printAreaPx: { short: 3600, long: 5400 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "40x60", sizeIn: "16x24", sku: "GLOBAL-CFPM-16X24", printAreaPx: { short: 3618, long: 6018 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "40x60", sizeIn: "16x24", sku: "GLOBAL-CFP-16X24", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-CFPM-20X28", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-CFP-20X28", printAreaPx: { short: 6000, long: 8400 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "50x75", sizeIn: "20x30", sku: "GLOBAL-CFPM-20X30", printAreaPx: { short: 4800, long: 7800 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "50x75", sizeIn: "20x30", sku: "GLOBAL-CFP-20X30", printAreaPx: { short: 6000, long: 9000 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "60x90", sizeIn: "24x36", sku: "GLOBAL-CFPM-24X36", printAreaPx: { short: 6000, long: 9600 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "60x90", sizeIn: "24x36", sku: "GLOBAL-CFP-24X36", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "framed", mount: "white", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-CFPM-28X40", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "framed", mount: "none", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-CFP-28X40", printAreaPx: { short: 8400, long: 12000 }, printAreaDpi: 300 },
  { format: "canvas", size: "20x30", sizeIn: "8x12", sku: "GLOBAL-CAN-8X12", printAreaPx: { short: 3345, long: 4545 }, printAreaDpi: 300 },
  { format: "canvas", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-CAN-12X16", printAreaPx: { short: 4545, long: 5745 }, printAreaDpi: 300 },
  { format: "canvas", size: "30x45", sizeIn: "12x18", sku: "GLOBAL-CAN-12X18", printAreaPx: { short: 4545, long: 6345 }, printAreaDpi: 300 },
  { format: "canvas", size: "40x60", sizeIn: "16x24", sku: "GLOBAL-CAN-16X24", printAreaPx: { short: 5745, long: 8145 }, printAreaDpi: 300 },
  { format: "canvas", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-CAN-20X28", printAreaPx: { short: 6945, long: 9345 }, printAreaDpi: 300 },
  { format: "canvas", size: "50x75", sizeIn: "20x30", sku: "GLOBAL-CAN-20X30", printAreaPx: { short: 6945, long: 9945 }, printAreaDpi: 300 },
  { format: "canvas", size: "60x90", sizeIn: "24x36", sku: "GLOBAL-CAN-24X36", printAreaPx: { short: 8145, long: 11745 }, printAreaDpi: 300 },
  { format: "canvas", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-CAN-28X40", printAreaPx: { short: 9600, long: 13200 }, printAreaDpi: 300 },
] as const satisfies readonly PrintProductEntry[];

export type PrintProduct = (typeof PRINT_PRODUCTS)[number];

/** The cm sizes the table offers, derived so a new size cannot be half-added. */
export type PrintSize = PrintProduct["size"];

/** The inch suffix Prodigi uses, derived from the table. */
export type ProdigiSizeIn = PrintProduct["sizeIn"];

/** A product's print area in inches, short/long — the unit #299 computes in. */
export function printAreaIn(product: PrintProductEntry): {
  short: number;
  long: number;
} {
  return {
    short: product.printAreaPx.short / product.printAreaDpi,
    long: product.printAreaPx.long / product.printAreaDpi,
  };
}

/**
 * The product's nominal size in inches, short/long — what the moulding is
 * actually made to, as opposed to the smaller `printAreaIn` the photo fills.
 * The preview maths needs both: the box is the nominal size, the crop is the
 * print area (#326).
 *
 * `sizeIn` is `string` on the table's type, so `split("x")` can hand back
 * anything — a missing half, a third component, or `Number("")` = `NaN` from a
 * trailing `x`. All three reach the preview as silent `NaN` geometry, the same
 * failure #118 was about, so the shape is checked here and a malformed
 * constant throws rather than propagating. This is a programming error in the
 * table, not a customer path: the values are literals in this file.
 */
export function nominalSizeIn(product: PrintProductEntry): {
  short: number;
  long: number;
} {
  const parts = product.sizeIn.split("x");
  // `Number(undefined)` is `NaN`, so a missing half is rejected by the finite
  // check below. Testing `parts[i] === undefined` first would be a branch that
  // can never be taken — `split` returns at least one element, and any input
  // short of two fails the length check — which is worse than no check: it
  // reads like a guard and the coverage gate would keep reporting it untaken.
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (
    parts.length !== 2 ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    a <= 0 ||
    b <= 0
  ) {
    throw new Error(`malformed sizeIn ${JSON.stringify(product.sizeIn)} for ${product.sku}`);
  }
  return { short: Math.min(a, b), long: Math.max(a, b) };
}

/**
 * The product for a `(format, size, mount, paper)` key, or null. The key is the
 * identity: there is no assumption that every size exists in every format, so
 * callers that accept a raw size must handle a miss. The mount only narrows a
 * framed lookup and the paper only a giclée one; for the other formats each is
 * ignored, and a null means the default (the mounted frame, the Matte Art
 * paper), so a caller that predates #335/#337 reads the same product it always
 * did.
 *
 * `mount` is required (#335) and `paper` is required (#337): a caller that does
 * not care passes `null` explicitly. Leaving them defaulted let /api/quote omit
 * one and still compile, which is the exact shape of the bug where an unmounted
 * selection was priced as the mounted CFPM SKU — the variant is part of the
 * key, and an omitted one must be a decision the caller writes down, not a
 * default.
 *
 * `products` defaults to the pinned table and is injectable so a missing key
 * can be exercised before the catalogue has one.
 */
export function findProduct(
  format: PhysicalFormat,
  size: string,
  mount: FramedMount | null,
  paper: PrintPaper | null,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): PrintProductEntry | null {
  return (
    products.find(
      (p) =>
        p.format === format &&
        p.size === size &&
        (p.format !== "framed" ||
          p.mount === (mount ?? DEFAULT_FRAMED_MOUNT)) &&
        (p.format !== "giclee" ||
          p.paper === (paper ?? DEFAULT_PRINT_PAPER)),
    ) ?? null
  );
}

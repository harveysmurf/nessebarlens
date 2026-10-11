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

export type PrintProductEntry =
  | FramedProductEntry
  | (PrintProductBase & { format: Exclude<PhysicalFormat, "framed"> });

export const PRINT_PRODUCTS = [
  // 2:3 sizes (#303) sit alongside the 3:4 and 5:7 ones, ordered small to large
  // by area within each format. The 2:3 SKUs are the cm-nominal IDs: 20x30 =
  // 8x12", 30x45 = 12x18", 40x60 = 16x24", 50x75 = 20x30", 60x90 = 24x36".
  { format: "giclee", size: "20x30", sizeIn: "8x12", sku: "GLOBAL-FAP-8X12", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-FAP-12X16", printAreaPx: { short: 3600, long: 4800 }, printAreaDpi: 300 },
  { format: "giclee", size: "30x45", sizeIn: "12x18", sku: "GLOBAL-FAP-12X18", printAreaPx: { short: 3600, long: 5400 }, printAreaDpi: 300 },
  { format: "giclee", size: "40x60", sizeIn: "16x24", sku: "GLOBAL-FAP-16X24", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-FAP-20X28", printAreaPx: { short: 6000, long: 8400 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x75", sizeIn: "20x30", sku: "GLOBAL-FAP-20X30", printAreaPx: { short: 6000, long: 9000 }, printAreaDpi: 300 },
  { format: "giclee", size: "60x90", sizeIn: "24x36", sku: "GLOBAL-FAP-24X36", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "giclee", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-FAP-28X40", printAreaPx: { short: 8400, long: 12000 }, printAreaDpi: 300 },
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
 * The product for a `(format, size, mount)` key, or null. The key is the
 * identity: there is no assumption that every size exists in every format, so
 * callers that accept a raw size must handle a miss. The mount only narrows a
 * framed lookup; for the other formats it is ignored, and a null mount means
 * the default (the mounted frame), so a caller that predates #335 reads the
 * same product it always did.
 *
 * `mount` is required (#335): a caller that does not care passes `null`
 * explicitly. Leaving it defaulted let /api/quote omit it and still compile,
 * which is the exact shape of the bug where an unmounted selection was priced
 * as the mounted CFPM SKU — the mount is part of the key, and an omitted one
 * must be a decision the caller writes down, not a default.
 *
 * `products` defaults to the pinned table and is injectable so a missing key
 * can be exercised before the catalogue has one.
 */
export function findProduct(
  format: PhysicalFormat,
  size: string,
  mount: FramedMount | null,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): PrintProductEntry | null {
  return (
    products.find(
      (p) =>
        p.format === format &&
        p.size === size &&
        (p.format !== "framed" ||
          p.mount === (mount ?? DEFAULT_FRAMED_MOUNT)),
    ) ?? null
  );
}

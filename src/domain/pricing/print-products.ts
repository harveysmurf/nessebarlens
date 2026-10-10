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

export type PrintProductEntry = {
  format: PhysicalFormat;
  /** Centimetres, e.g. "30x40". */
  size: string;
  /** Prodigi's inchsuffix, e.g. "12x16". */
  sizeIn: string;
  sku: string;
  printAreaPx: { short: number; long: number };
  /** Prodigi's catalogue resolution standard for these products. */
  printAreaDpi: number;
};

export const PRINT_PRODUCTS = [
  { format: "giclee", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-FAP-12X16", printAreaPx: { short: 3600, long: 4800 }, printAreaDpi: 300 },
  { format: "giclee", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-FAP-20X28", printAreaPx: { short: 6000, long: 8400 }, printAreaDpi: 300 },
  { format: "giclee", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-FAP-28X40", printAreaPx: { short: 8400, long: 12000 }, printAreaDpi: 300 },
  { format: "framed", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-CFPM-12X16", printAreaPx: { short: 2400, long: 3600 }, printAreaDpi: 300 },
  { format: "framed", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-CFPM-20X28", printAreaPx: { short: 4800, long: 7200 }, printAreaDpi: 300 },
  { format: "framed", size: "70x100", sizeIn: "28x40", sku: "GLOBAL-CFPM-28X40", printAreaPx: { short: 7200, long: 10800 }, printAreaDpi: 300 },
  { format: "canvas", size: "30x40", sizeIn: "12x16", sku: "GLOBAL-CAN-12X16", printAreaPx: { short: 4545, long: 5745 }, printAreaDpi: 300 },
  { format: "canvas", size: "50x70", sizeIn: "20x28", sku: "GLOBAL-CAN-20X28", printAreaPx: { short: 6945, long: 9345 }, printAreaDpi: 300 },
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
 * The product for a `(format, size)` pair, or null. The pair is the identity:
 * there is no assumption that every size exists in every format, so callers
 * that accept a raw size must handle a miss.
 *
 * `products` defaults to the pinned table and is injectable so a missing pair
 * can be exercised before the catalogue has one.
 */
export function findProduct(
  format: PhysicalFormat,
  size: string,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): PrintProductEntry | null {
  return (
    products.find((p) => p.format === format && p.size === size) ?? null
  );
}

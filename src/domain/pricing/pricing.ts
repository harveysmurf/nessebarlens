import type { Orientation } from "../catalog/master-facts";
import { Eur, eurToCents } from "./money";
import { PRINT_PRODUCTS, type PrintSize } from "./print-products";

/**
 * The EUR grammar and the cents conversion are money.ts's; these two names
 * stay on `pricing` because that is where every caller already imports them
 * from. The re-export is the one named exception to "a module only exports
 * what it defines" in tests/single-source-grammar.test.mts, so a second path
 * to a declaration anywhere else still fails there.
 */
export { eurToCents, parseEurAmount } from "./money";

export type PrintFormat = "giclee" | "framed" | "canvas" | "digital";
// PrintSize is the print table's size column; re-exported here because that is
// where every caller already imports it from (print-products.ts owns it).
export type { PrintSize };
export type FrameFinish = "black" | "white" | "brown";

/** Merchandise-only EUR. Shipping is separate (Stripe shipping_options). */
export const DIGITAL_PRICE_EUR = 30;

/** Customer merchandise = Prodigi unitCost × this margin. */
export const PRODIGI_MARGIN = 1.2;

/**
 * The margin is applied to whole cents, not to a float: the unit cost is a
 * parsed EUR amount, so it has cents already, and the only rounding left is
 * the one that folds the scaled cents back into an integer. The result goes
 * back to the float EUR the quote and Stripe metadata speak.
 */
export function merchandiseFromUnitCost(unitCostEur: number): number {
  const unitCost = Eur.fromCents(eurToCents(unitCostEur));
  return unitCost.multiplyBy(PRODIGI_MARGIN).cents() / 100;
}

// Typed as Record<union, string> rather than switch: adding a member to
// PrintFormat/PrintSize then fails to compile here instead of silently
// returning undefined at runtime.
const FORMAT_LABELS: Record<PrintFormat, string> = {
  giclee: "Giclée Fine Art Print",
  framed: "Framed Fine Art",
  canvas: "Stretched Canvas",
  digital: "High-Res Digital Download",
};

/** "30x40" → "30 × 40"; used for both the cm and the inch half. */
function sizeWords(size: string): string {
  const [a, b] = size.split("x");
  return `${a} × ${b}`;
}

/** "30 × 40" → "40 × 30". */
function reversedWords(words: string): string {
  const [a, b] = words.split(" × ");
  return `${b} × ${a}`;
}

/** The cm and inch words per size, short edge first, derived from the table. */
const SIZE_WORDS: Record<PrintSize, { cm: string; inches: string }> =
  Object.fromEntries(
    PRINT_PRODUCTS.map((product) => [
      product.size,
      { cm: sizeWords(product.size), inches: sizeWords(product.sizeIn) },
    ]),
  ) as Record<PrintSize, { cm: string; inches: string }>;

export function formatLabel(format: PrintFormat): string {
  return FORMAT_LABELS[format];
}

/**
 * Label per size, derived from the table so a size cannot be offered without
 * words. The tier words ("Standard"/"Medium"/"Gallery") are gone: the area
 * order already tells the buyer which is larger, and a tier name that is not
 * in the table is a second vocabulary to maintain.
 *
 * A landscape photo reads long edge first (#302): the frame is the product's
 * (portrait) orientation, but the *photo* hangs landscape, so its width is the
 * long edge and naming it first matches what the buyer sees. The cm size and
 * the Prodigi SKU stay short edge first — this is presentation only, and the
 * value the checkout carries is unchanged.
 */
export function sizeLabel(size: PrintSize, orientation?: Orientation): string {
  const { cm, inches } = SIZE_WORDS[size];
  if (orientation === "landscape") {
    return `${reversedWords(cm)} cm (${reversedWords(inches)}")`;
  }
  return `${cm} cm (${inches}")`;
}

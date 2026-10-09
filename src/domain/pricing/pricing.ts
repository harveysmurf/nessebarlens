import { Eur, eurToCents } from "./money";

/**
 * The EUR grammar and the cents conversion are money.ts's; these two names
 * stay on `pricing` because that is where every caller already imports them
 * from. The re-export is the one named exception to "a module only exports
 * what it defines" in tests/single-source-grammar.test.mts, so a second path
 * to a declaration anywhere else still fails there.
 */
export { eurToCents, parseEurAmount } from "./money";

export type PrintFormat = "giclee" | "framed" | "canvas" | "digital";
export type PrintSize = "30x40" | "50x70" | "70x100";
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

const SIZE_LABELS: Record<PrintSize, string> = {
  "30x40": '30 × 40 cm (12 × 16") — Standard',
  "50x70": '50 × 70 cm (20 × 28") — Medium',
  "70x100": '70 × 100 cm (28 × 40") — Gallery',
};

export function formatLabel(format: PrintFormat): string {
  return FORMAT_LABELS[format];
}

export function sizeLabel(size: PrintSize): string {
  return SIZE_LABELS[size];
}

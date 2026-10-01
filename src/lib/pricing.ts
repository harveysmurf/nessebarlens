export type PrintFormat = "giclee" | "framed" | "canvas" | "digital";
export type PrintSize = "30x40" | "50x70" | "70x100";
export type FrameFinish = "black" | "white" | "brown";

/** Merchandise-only EUR. Shipping is separate (Stripe shipping_options). */
export const DIGITAL_PRICE_EUR = 30;

/** Customer merchandise = Prodigi unitCost × this margin. */
export const PRODIGI_MARGIN = 1.2;

export function merchandiseFromUnitCost(unitCostEur: number): number {
  return Math.round(unitCostEur * PRODIGI_MARGIN * 100) / 100;
}

export function eurToCents(eur: number): number {
  return Math.round(eur * 100);
}

/**
 * Parse a decimal EUR string as it arrives over the wire (Prodigi quotes,
 * stored order metadata). Returns null for anything that is not a plain
 * non-negative amount with at most two decimals.
 *
 * This grammar is written down once. Two copies already drifted: a stored-record
 * copy capping the integer part at six digits and a Prodigi copy that did not
 * made a >6-digit amount readable from a quote and rejected from a record, and
 * which one you got depended on which module you were in.
 */
export function parseEurAmount(raw: string | null | undefined): number | null {
  if (!raw || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(raw)) return null;
  return Number(raw);
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

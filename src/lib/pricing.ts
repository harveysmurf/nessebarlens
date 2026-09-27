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

export function formatLabel(format: PrintFormat): string {
  switch (format) {
    case "giclee":
      return "Giclée Fine Art Print";
    case "framed":
      return "Framed Fine Art";
    case "canvas":
      return "Stretched Canvas";
    case "digital":
      return "High-Res Digital Download";
  }
}

export function sizeLabel(size: PrintSize): string {
  switch (size) {
    case "30x40":
      return '30 × 40 cm (12 × 16") — Standard';
    case "50x70":
      return '50 × 70 cm (20 × 28") — Medium';
    case "70x100":
      return '70 × 100 cm (28 × 40") — Gallery';
  }
}

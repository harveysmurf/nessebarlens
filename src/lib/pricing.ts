export type PrintFormat = "giclee" | "framed" | "canvas" | "digital";
export type PrintSize = "30x40" | "50x70" | "70x100";
export type FrameFinish = "oak" | "black" | "white";

export const SIZE_ADD_EUR: Record<PrintSize, number> = {
  "30x40": 0,
  "50x70": 18,
  "70x100": 40,
};

export const FORMAT_ADD_EUR: Record<Exclude<PrintFormat, "digital">, number> = {
  giclee: 0,
  framed: 40,
  canvas: 30,
};

/** Merchandise-only EUR. Shipping is separate (Stripe shipping_options). */
export const DIGITAL_PRICE_EUR = 30;

/** Senior Dev lock: physical Checkout only, not folded into quoteEur. */
export const EU_FLAT_SHIPPING_CENTS = 1200;

export function computeQuoteEur(opts: {
  fromPriceEur: number;
  format: PrintFormat;
  size: PrintSize | null;
}): number {
  if (opts.format === "digital") {
    return DIGITAL_PRICE_EUR;
  }
  if (!opts.size) {
    throw new Error("size required for physical formats");
  }
  return (
    opts.fromPriceEur +
    FORMAT_ADD_EUR[opts.format] +
    SIZE_ADD_EUR[opts.size]
  );
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
      return '50 × 70 cm (20 × 28") — Medium (+€18)';
    case "70x100":
      return '70 × 100 cm (28 × 40") — Gallery (+€40)';
  }
}

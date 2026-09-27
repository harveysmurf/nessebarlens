/**
 * Prodigi SKU map — single source for format+size → SKU.
 * Verified 2026-09-27 against api.sandbox.prodigi.com GET /v4.0/products/{sku}.
 * SKU_MAP_READY in fulfillment.ts stays false until Phase 2 order creation lands.
 */

import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";

export type PhysicalFormat = Exclude<PrintFormat, "digital">;

export type ProdigiSizeIn = "12x16" | "20x28" | "28x40";

export type SkuEntry = {
  sku: string;
  sizeCm: PrintSize;
  sizeIn: ProdigiSizeIn;
  /** Required Prodigi item attributes (framed needs color). */
  attributes: Record<string, string>;
};

/** cm size shown in UI → Prodigi inch SKU suffix. */
export const SIZE_TO_INCH: Record<PrintSize, ProdigiSizeIn> = {
  "30x40": "12x16",
  "50x70": "20x28",
  "70x100": "28x40",
};

const FORMAT_PREFIX: Record<PhysicalFormat, string> = {
  giclee: "GLOBAL-FAP",
  framed: "GLOBAL-CFPM",
  canvas: "GLOBAL-CAN",
};

/** UI frame finish → Prodigi CFPM `color` attribute. */
export const FRAME_COLOR: Record<FrameFinish, string> = {
  black: "black",
  white: "white",
  brown: "brown",
};

export const FRAME_FINISHES: FrameFinish[] = ["black", "white", "brown"];

export const PHYSICAL_FORMATS: PhysicalFormat[] = ["giclee", "framed", "canvas"];

export const PRINT_SIZES: PrintSize[] = ["30x40", "50x70", "70x100"];

export function resolveSku(
  format: PhysicalFormat,
  size: PrintSize,
  frame: FrameFinish | null = null,
): SkuEntry {
  const sizeIn = SIZE_TO_INCH[size];
  const sku = `${FORMAT_PREFIX[format]}-${sizeIn.toUpperCase()}`;
  const attributes: Record<string, string> = {};
  if (format === "framed") {
    if (!frame || !(frame in FRAME_COLOR)) {
      throw new Error("frame required for framed format (black|white|brown)");
    }
    attributes.color = FRAME_COLOR[frame];
  }
  return { sku, sizeCm: size, sizeIn, attributes };
}

/** All 9 physical SKUs (format × size). Frame defaults to black for CFPM. */
export function allPhysicalSkus(): SkuEntry[] {
  const out: SkuEntry[] = [];
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      out.push(resolveSku(format, size, format === "framed" ? "black" : null));
    }
  }
  return out;
}

export const PINNED_SKUS: readonly string[] = [
  "GLOBAL-FAP-12X16",
  "GLOBAL-FAP-20X28",
  "GLOBAL-FAP-28X40",
  "GLOBAL-CFPM-12X16",
  "GLOBAL-CFPM-20X28",
  "GLOBAL-CFPM-28X40",
  "GLOBAL-CAN-12X16",
  "GLOBAL-CAN-20X28",
  "GLOBAL-CAN-28X40",
] as const;

/**
 * Prodigi SKU map — the format+size → SKU view of the pinned product table.
 *
 * SKUs, sizes and inch suffixes come from PRINT_PRODUCTS (print-products.ts),
 * which the captured Prodigi fixture is contract-tested against; this module
 * only adds the request attributes each format carries. Every UI format×size
 * resolving to a pinned SKU is enforced by tests/sku-map.test.mts.
 */

import type { FrameFinish, PrintFormat, PrintSize } from "./pricing";
import {
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_PAPER,
  findProduct,
  FRAMED_MOUNTS,
  PRINT_PAPERS,
  PRINT_PRODUCTS,
  type FramedMount,
  type PrintPaper,
  type ProdigiSizeIn,
} from "./print-products";

export type PhysicalFormat = Exclude<PrintFormat, "digital">;

export type { FramedMount, PrintPaper, ProdigiSizeIn };
export { FRAMED_MOUNTS, PRINT_PAPERS };

export type SkuEntry = {
  sku: string;
  sizeCm: PrintSize;
  sizeIn: ProdigiSizeIn;
  /** Required Prodigi item attributes (framed needs color). */
  attributes: Record<string, string>;
};

/** cm size shown in UI → Prodigi inch SKU suffix, derived from the table. */
export const SIZE_TO_INCH: Record<PrintSize, ProdigiSizeIn> =
  Object.fromEntries(
    PRINT_PRODUCTS.map((product) => [product.size, product.sizeIn]),
  ) as Record<PrintSize, ProdigiSizeIn>;

/** UI frame finish → Prodigi CFPM `color` attribute. */
export const FRAME_COLOR: Record<FrameFinish, string> = {
  black: "black",
  white: "white",
  brown: "brown",
};

/**
 * Prodigi CAN `wrap` attribute — how the artwork meets the stretcher-bar edge.
 *
 * Prodigi lists this as a *required* attribute on every GLOBAL-CAN-* SKU, so an
 * omitted `wrap` makes /v4.0/quotes reject the whole request with
 * MissingRequiredAttributes and HTTP 400. That is why every canvas size failed
 * to quote: resolveSku sent `attributes: {}` and Prodigi had no default to fall
 * back on.
 *
 * `ImageWrap` continues the artwork around the 38mm edge, which is what a gallery
 * canvas is. The other three (Black/White/MirrorWrap) all quote at the same
 * price — verified 2026-10-01 against api.sandbox.prodigi.com — so this is an
 * aesthetic choice, not a cost one. It is a constant rather than a UI option
 * because nothing in the product currently exposes a wrap choice.
 */
export const CANVAS_WRAP = "ImageWrap";

// Derived from the attribute map so a finish cannot exist in one and not the
// other; hand-listing them side by side would let a finish exist in one and
// not the other.
export const FRAME_FINISHES = Object.keys(FRAME_COLOR) as FrameFinish[];

export const PHYSICAL_FORMATS: PhysicalFormat[] = ["giclee", "framed", "canvas"];

/**
 * Everything we can sell, including "digital" which has no Prodigi SKU.
 * Owned here so the two request parsers and fulfillment share one allow-list.
 */
export const SELLABLE_FORMATS: PrintFormat[] = [...PHYSICAL_FORMATS, "digital"];

/** "30x40|50x70|70x100" — the allow-list as a human-readable label. */
export function formatListLabel(
  values: readonly string[],
  separator = "|",
): string {
  return values.join(separator);
}

/** The distinct cm sizes in the table, in catalog order (derived, not listed). */
export const PRINT_SIZES: PrintSize[] = [
  ...new Set(PRINT_PRODUCTS.map((product) => product.size as PrintSize)),
];

// Membership tests for the allow-lists above, owned here because this module
// owns the lists. Callers must not cast their way to one —
// `PRINT_SIZES.includes(size as PrintSize)` followed by a second
// `size as PrintSize` at the use — because the cast, not the check, would be
// what makes the value valid. A predicate narrows once and holds at every later use, and
// adding a format or size cannot leave a caller validating against a
// hand-typed union that has drifted from the list.
export function isSellableFormat(value: unknown): value is PrintFormat {
  return typeof value === "string" && SELLABLE_FORMATS.includes(value as PrintFormat);
}

export function isPhysicalFormat(value: unknown): value is PhysicalFormat {
  return typeof value === "string" && PHYSICAL_FORMATS.includes(value as PhysicalFormat);
}

export function isPrintSize(value: unknown): value is PrintSize {
  return typeof value === "string" && PRINT_SIZES.includes(value as PrintSize);
}

export function isFrameFinishValue(value: unknown): value is FrameFinish {
  return typeof value === "string" && FRAME_FINISHES.includes(value as FrameFinish);
}

/** Membership test for the framed-mount allow-list, owned with the list. */
export function isFramedMountValue(value: unknown): value is FramedMount {
  return (
    typeof value === "string" && FRAMED_MOUNTS.includes(value as FramedMount)
  );
}

/** Membership test for the giclée-paper allow-list, owned with the list. */
export function isPrintPaperValue(value: unknown): value is PrintPaper {
  return typeof value === "string" && PRINT_PAPERS.includes(value as PrintPaper);
}

/**
 * The pinned SKU for a `(format, size, frame, mount, paper)` selection.
 *
 * `mount` (#335) and `paper` (#337) are required and must be threaded from the
 * one identity that owns them: an omitted variant is what let /api/quote
 * silently price the default product for a different selection. Callers that do
 * not care pass `null` explicitly. `frame` keeps its null default because a
 * non-framed selection genuinely has none and the framed arm throws below.
 */
export function resolveSku(
  format: PhysicalFormat,
  size: PrintSize,
  frame: FrameFinish | null = null,
  mount: FramedMount | null,
  paper: PrintPaper | null,
): SkuEntry {
  // A null mount means the default (mounted) and a null paper the default
  // (Matte Art); only framed products carry a mount and only giclée a paper.
  const product = findProduct(format, size, mount, paper);
  if (!product) {
    // The typed callers only pass keys from PRINT_SIZES, which the table
    // defines, so this is a programming error rather than a customer path.
    throw new Error(
      `no print product for ${format}/${size}/${mount ?? DEFAULT_FRAMED_MOUNT}/${paper ?? DEFAULT_PRINT_PAPER}`,
    );
  }
  // The table's own type is the entry shape (sizeIn: string); the derived
  // ProdigiSizeIn union is a projection of the same table, so the literal is
  // already a member. The cast restates the invariant the table encodes.
  const sizeIn = product.sizeIn as ProdigiSizeIn;
  const sku = product.sku;
  const attributes: Record<string, string> = {};
  if (format === "framed") {
    if (!frame || !(frame in FRAME_COLOR)) {
      throw new Error(
        `frame required for framed format (${formatListLabel(FRAME_FINISHES)})`,
      );
    }
    attributes.color = FRAME_COLOR[frame];
  }
  if (format === "canvas") {
    attributes.wrap = CANVAS_WRAP;
  }
  return { sku, sizeCm: size, sizeIn, attributes };
}

/**
 * Every physical SKU (format × size, times each variant a format carries):
 * 40 today. Frame defaults to black, mount to the default (mounted) and paper
 * to the default (Matte Art), so the list is complete without hand-typed
 * pairs.
 */
export function allPhysicalSkus(): SkuEntry[] {
  const out: SkuEntry[] = [];
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      if (format === "framed") {
        for (const mount of FRAMED_MOUNTS) {
          out.push(resolveSku(format, size, "black", mount, null));
        }
      } else if (format === "giclee") {
        for (const paper of PRINT_PAPERS) {
          out.push(resolveSku(format, size, null, null, paper));
        }
      } else {
        out.push(resolveSku(format, size, null, null, null));
      }
    }
  }
  return out;
}

/** The same SKUs allPhysicalSkus() builds, in that order — derived, not listed. */
export const PINNED_SKUS: readonly string[] = allPhysicalSkus().map(
  (entry) => entry.sku,
);

/**
 * A print selection: one value object, one validation pass.
 *
 * The rules here are the ones checkout and quote have to agree on -- digital
 * carries neither size nor frame, a physical format always carries a size,
 * framed carries a finish and nothing else does -- and the ones the client
 * re-encodes when it builds a request body. Writing them once means a rule
 * change lands in one place instead of on one side of the API.
 *
 * What this module deliberately does not know: whether a body carries a
 * `photoSlug` (checkout has one, quote has none), and which formats an
 * endpoint accepts (a quote is physical-only, a checkout may be digital).
 * Callers check their own allow-list first and map the closed `reason` union
 * below to their own pinned wording -- a factory that emitted endpoint prose
 * would put two copies of that prose back into the world.
 */

import type { FrameFinish, PrintFormat, PrintSize } from "../pricing/pricing";
import {
  findProduct,
  PRINT_PRODUCTS,
  type PrintProductEntry,
} from "../pricing/print-products";
import {
  isFrameFinishValue,
  isPrintSize,
  type PhysicalFormat,
} from "../pricing/sku-map";

export type DigitalPrintSpecification = { kind: "digital" };

export type PhysicalPrintSpecification = {
  kind: "physical";
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
};

export type PrintSpecification =
  | DigitalPrintSpecification
  | PhysicalPrintSpecification;

/**
 * Why a selection was refused, as a closed set of domain reasons. Checkout
 * and quote word size and digital differently for their own endpoints, so the
 * text each buyer sees is mapped from these reasons by the parser that owns
 * the wording.
 */
export type PrintSpecificationReason =
  | "digital-rejects-size"
  | "digital-rejects-frame"
  | "size-required"
  | "size-not-offered-for-format"
  | "frame-required"
  | "frame-not-allowed";

export type PrintSpecificationResult =
  | { ok: true; value: PrintSpecification }
  | { ok: false; reason: PrintSpecificationReason };

export type PhysicalPrintResult =
  | { ok: true; value: PhysicalPrintSpecification }
  | { ok: false; reason: PrintSpecificationReason };

/**
 * The frame projection, in its total form: the finish travels only with
 * framed. Client builders use it to normalise a stale selection instead of
 * forwarding it to be refused, and the factory below enforces the same rule
 * as a refusal -- which is why both halves live in this module and not one
 * in each parser.
 */
export function frameForFormat(
  format: PrintFormat,
  frame: FrameFinish | null,
): FrameFinish | null {
  return format === "framed" ? frame : null;
}

/**
 * The physical arm of the specification, for call sites whose format, size
 * and frame are already typed: the configurator's own state, which a request
 * builder normalises rather than validates. Nothing is re-checked here,
 * because the types already say it holds; what the builder needs is the
 * projection, so the frame rule is read off the specification instead of
 * being spelled a second time in the client.
 */
export function physicalSpecification(
  format: PhysicalFormat,
  size: PrintSize,
  frame: FrameFinish | null,
): PhysicalPrintSpecification {
  return {
    kind: "physical",
    format,
    size,
    frame: frameForFormat(format, frame),
  };
}

/**
 * Validate a raw selection against the rules above.
 *
 * `format` arrives already accepted by the caller's own allow-list -- this is
 * the point after that check -- while `size` and `frame` are still whatever
 * the body carried: absent, null, or the wrong shape.
 *
 * Two signatures because the format decides the shape of success: a physical
 * format cannot produce the digital arm, so a caller that has already proved
 * its format physical (the quote parser) reads a physical specification
 * straight off the result and never has to ask. The overload is that
 * contract written down; the body below is the one function.
 */
export function parsePrintSpecification(
  format: PhysicalFormat,
  size: unknown,
  frame: unknown,
  products?: readonly PrintProductEntry[],
): PhysicalPrintResult;
export function parsePrintSpecification(
  format: PrintFormat,
  size: unknown,
  frame: unknown,
  products?: readonly PrintProductEntry[],
): PrintSpecificationResult;
export function parsePrintSpecification(
  format: PrintFormat,
  size: unknown,
  frame: unknown,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): PrintSpecificationResult {
  if (format === "digital") {
    if (size !== null && size !== undefined) {
      return { ok: false, reason: "digital-rejects-size" };
    }
    if (frame !== null && frame !== undefined) {
      return { ok: false, reason: "digital-rejects-frame" };
    }
    return { ok: true, value: { kind: "digital" } };
  }

  if (!isPrintSize(size)) {
    return { ok: false, reason: "size-required" };
  }

  // A size the table carries for some other format is not a size this format
  // offers: the pair is the identity, not the size alone. With today's table
  // this cannot fire, but the check is what lets a format-specific catalogue
  // grow without silently selling a size Prodigi has no SKU for.
  if (!findProduct(format, size, products)) {
    return { ok: false, reason: "size-not-offered-for-format" };
  }

  if (format === "framed") {
    if (!isFrameFinishValue(frame)) {
      return { ok: false, reason: "frame-required" };
    }
    return { ok: true, value: { kind: "physical", format, size, frame } };
  }

  // Every other physical format carries no finish, so a present one is a
  // refusal rather than a value to drop: the body asked for something the
  // format cannot have.
  if (frame !== null && frame !== undefined) {
    return { ok: false, reason: "frame-not-allowed" };
  }
  return {
    ok: true,
    value: { kind: "physical", format, size, frame: null },
  };
}

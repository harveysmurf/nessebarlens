/**
 * The print offer (#299): the sizes a master is sold at, per physical format,
 * and the validation and recalculation rules around it.
 *
 * The offer is the one value publishing (#300) writes, checkout (#301)
 * enforces and the configurator (#302) renders. It is always derived from
 * `assess`/`assessAll` in print-eligibility.ts — this module adds the offer
 * shape and the rules that keep a hand-edited offer honest, and nothing else.
 *
 * Pure: it imports only from `src/domain`.
 */

import type { PrintSize } from "../pricing/pricing";
import {
  findProduct,
  PRINT_PRODUCTS,
  type PrintProductEntry,
} from "../pricing/print-products";
import {
  isPhysicalFormat,
  isPrintSize,
  PHYSICAL_FORMATS,
  type PhysicalFormat,
} from "../pricing/sku-map";
import type { PrintSpecification } from "../ordering/print-spec";
import type { MasterFacts } from "./master-facts";
import { assess, type Assessment } from "./print-eligibility";

/**
 * Digital is always offered (#291 decision 5), so it is not a key here: the
 * offer is exactly the three physical formats, each with its own list. An empty
 * list is valid and means "this format is not sold for this photo".
 */
export type PrintOffer = Readonly<Record<PhysicalFormat, readonly PrintSize[]>>;

/**
 * Why a raw offer was refused, as a closed set. The caller maps these to its
 * own wording; this module does not own prose.
 */
export type OfferReason =
  | "not-a-map"
  | "missing-format"
  | "unknown-format"
  | "not-a-list"
  | "unknown-size"
  | "not-offered-for-format"
  | "duplicate-size"
  | "below-min-ppi"
  | "shape-mismatch";

export type OfferProblem = {
  /** The format the problem is about; `"(offer)"` for a problem with the map itself. */
  format: string;
  size?: string;
  reason: OfferReason;
  /** Present when the problem came from an assessment, for diagnostics. */
  effectivePpi?: number;
};

export type OfferResult =
  | { ok: true; offer: PrintOffer }
  | { ok: false; problems: OfferProblem[] };

/** The `format` on a problem about the offer map itself, not one of its keys. */
const ROOT = "(offer)";

/** An offer with every format listed explicitly and empty. */
function emptyOffer(): Record<PhysicalFormat, PrintSize[]> {
  return { giclee: [], framed: [], canvas: [] };
}

/**
 * The offer a master is eligible for, derived from the table. Sizes come out in
 * table order, so the smallest is first. This never returns options the caller
 * must narrow; `narrowOffer` does the narrowing against an owner's edits.
 */
export function eligibleOffer(master: MasterFacts): PrintOffer {
  const offer = emptyOffer();
  for (const product of PRINT_PRODUCTS) {
    if (assess(master, product).verdict.eligible) {
      offer[product.format].push(product.size);
    }
  }
  return offer;
}

/**
 * Validate a raw offer — one read back from a published YAML — against a
 * master and the table, collecting every problem rather than stopping at the
 * first. A valid offer names all three formats, lists no option twice, and
 * lists only options the master is eligible for.
 *
 * `products` defaults to the pinned table and is injectable so the
 * `not-offered-for-format` reason — a size the table carries for some other
 * format — can be exercised before the catalogue has such a pair, the same
 * shape `findProduct` and `parsePrintSpecification` use.
 */
export function parsePrintOffer(
  raw: unknown,
  master: MasterFacts,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): OfferResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: [{ format: ROOT, reason: "not-a-map" }] };
  }

  const map = raw as Record<string, unknown>;
  const problems: OfferProblem[] = [];
  const offer = emptyOffer();

  for (const key of Object.keys(map)) {
    if (!isPhysicalFormat(key)) {
      problems.push({ format: key, reason: "unknown-format" });
    }
  }

  for (const format of PHYSICAL_FORMATS) {
    if (!(format in map)) {
      problems.push({ format, reason: "missing-format" });
      continue;
    }

    const value = map[format];
    if (!Array.isArray(value)) {
      problems.push({ format, reason: "not-a-list" });
      continue;
    }

    const seen = new Set<string>();
    for (const entry of value) {
      if (!isPrintSize(entry)) {
        problems.push({
          format,
          ...(typeof entry === "string" ? { size: entry } : {}),
          reason: "unknown-size",
        });
        continue;
      }

      if (seen.has(entry)) {
        problems.push({ format, size: entry, reason: "duplicate-size" });
        continue;
      }
      seen.add(entry);

      const product = findProduct(format, entry, products);
      if (!product) {
        problems.push({
          format,
          size: entry,
          reason: "not-offered-for-format",
        });
        continue;
      }

      const assessment = assess(master, product);
      if (!assessment.verdict.eligible) {
        problems.push({
          format,
          size: entry,
          reason: assessment.verdict.reason,
          effectivePpi: assessment.effectivePpi,
        });
        continue;
      }

      offer[format].push(entry);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, offer };
}

/**
 * The recalculation rule (#291 decision 3): given the offer an owner last
 * saved and a freshly measured master, drop the options that are no longer
 * eligible, report the ones that became eligible, and never add the latter —
 * the owner narrows, only publishing adds. The returned offer is always the
 * current offer minus removals.
 */
export function narrowOffer(
  current: PrintOffer,
  master: MasterFacts,
): { offer: PrintOffer; removed: Assessment[]; newlyEligible: Assessment[] } {
  const offer = emptyOffer();
  const removed: Assessment[] = [];
  const newlyEligible: Assessment[] = [];

  for (const product of PRINT_PRODUCTS) {
    const assessment = assess(master, product);
    const listed = current[product.format].includes(product.size);

    if (assessment.verdict.eligible) {
      if (listed) offer[product.format].push(product.size);
      else newlyEligible.push(assessment);
    } else if (listed) {
      removed.push(assessment);
    }
  }

  return { offer, removed, newlyEligible };
}

/**
 * Whether an offer includes a specification. Digital carries no size, so it is
 * always offered; a physical spec is offered exactly when its size is listed
 * for its format.
 */
export function offers(offer: PrintOffer, spec: PrintSpecification): boolean {
  if (spec.kind === "digital") return true;
  return offer[spec.format].includes(spec.size);
}

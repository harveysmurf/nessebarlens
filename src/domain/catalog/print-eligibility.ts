/**
 * Print eligibility (#299): which of the pinned products a master can be sold
 * as, and why not.
 *
 * This is the pure domain half of #291 — publishing (#300), checkout (#301) and
 * the configurator (#302) all read the offer it produces, but nothing here
 * wires, reads the catalog or touches a network. It consumes `master.orientation`
 * from #295 as the single orientation source: it never re-derives it from a
 * derivative rung and never compares the raw pre-rotation W×H (#311 owns the
 * hardening). The print areas come from the pinned table (#296).
 *
 * The one convention that is not obvious — the print area is turned to the
 * master's orientation, long edge meeting long edge — was confirmed against
 * Prodigi in #298: Prodigi does not rotate, and the site sends a pre-rotated
 * asset (#307), so the maths pairs the master's long edge with the area's long
 * edge. Stored as an unordered `{ short, long }` pair, the area carries no
 * orientation of its own; pairing long with long is the whole "turn".
 */

import {
  printAreaIn,
  PRINT_PRODUCTS,
  type PrintProductEntry,
} from "../pricing/print-products";
import type { PhysicalFormat } from "../pricing/sku-map";
import { orientationOf, type MasterFacts } from "./master-facts";

/**
 * The minimum effective PPI a product is offered at, per physical format
 * (#291 decision 1). PPI is source-image pixels per printed inch — not the
 * printer's DPI. Framed uses the mount window, canvas the area including the
 * wrap; the areas themselves live in the pinned table.
 */
export const MIN_PRINT_PPI: Record<PhysicalFormat, number> = {
  giclee: 220,
  framed: 220,
  canvas: 150,
};

/** Why a product is not offered for a master. */
export type IneligibleReason = "below-min-ppi" | "shape-mismatch";

export type Assessment = {
  product: PrintProductEntry;
  /** Floor of the tighter of the two edges' pixels-per-inch. */
  effectivePpi: number;
  /** 0..1 of the master discarded by the fill crop. */
  cropFraction: number;
  verdict:
    | { eligible: true }
    | { eligible: false; reason: IneligibleReason };
};

/**
 * Assess one product against one master.
 *
 * `shape-mismatch` is checked before the PPI floor and fails closed: a square
 * master may only go into a square product and vice versa, and there is no
 * rotation or crop that reconciles the two. The crop fraction is still reported
 * for every verdict — publishing (#300) reports it regardless — so a caller can
 * always show how much of the frame a fill would discard.
 */
export function assess(
  master: MasterFacts,
  product: PrintProductEntry,
): Assessment {
  const area = printAreaIn(product);
  const masterLong = Math.max(master.width, master.height);
  const masterShort = Math.min(master.width, master.height);
  const areaLong = Math.max(area.long, area.short);
  const areaShort = Math.min(area.long, area.short);

  const effectivePpi = Math.floor(
    Math.min(masterLong / areaLong, masterShort / areaShort),
  );

  const masterRatio = masterLong / masterShort;
  const areaRatio = areaLong / areaShort;
  const cropFraction =
    1 - Math.min(masterRatio, areaRatio) / Math.max(masterRatio, areaRatio);

  const masterSquare = master.orientation === "square";
  // The product's squareness uses the same 1% tolerance the master's orientation
  // was derived with (#295), so "square" means one thing in this module. No
  // product in today's table is square; the branch exists for the day #303 adds
  // one, and the fail-closed rule above is why it must be answered either way.
  const productSquare =
    orientationOf(areaLong, areaShort) === "square";

  const verdict: Assessment["verdict"] =
    masterSquare !== productSquare
      ? { eligible: false, reason: "shape-mismatch" }
      : effectivePpi < MIN_PRINT_PPI[product.format]
        ? { eligible: false, reason: "below-min-ppi" }
        : { eligible: true };

  return { product, effectivePpi, cropFraction, verdict };
}

/**
 * Assess every product in the table, in table order. The order is the table's
 * — giclée, framed, canvas, each short to long — so a caller that renders the
 * assessments shows the buyer the same sequence the table was written in.
 */
export function assessAll(
  master: MasterFacts,
  products: readonly PrintProductEntry[] = PRINT_PRODUCTS,
): Assessment[] {
  return products.map((product) => assess(master, product));
}

import type { Orientation } from "./master-facts";

/**
 * The rotation that turns a master into the print asset Prodigi receives (#307).
 *
 * Prodigi does not rotate (#298): every pinned print area is portrait, and the
 * order engine keys its layout off the uploaded asset's pixel dimensions. So a
 * landscape master must be turned 90° clockwise before upload, and a portrait
 * or square master is left alone. The decision rests only on the orientation,
 * never on the SKU, because no portrait variant exists.
 *
 * Near-square (#311). `orientationOf` calls anything within `SQUARE_TOLERANCE`
 * (1.01) square, so a 10100×10000 master is not turned. That is safe because a
 * square frame has no long edge to orient: turning it would only reorder the
 * fill crop, and the ±1% difference at the boundary is a fraction of the area
 * the crop discards anyway. The tolerance is shared with print eligibility
 * (#299), so "square" means one thing across the catalog rather than two
 * nearly-equal rules. Past the boundary the long edge decides the word, and
 * only a landscape turns, so the asset is never left unrotated when the facts
 * call it landscape.
 *
 * This is pure: it turns an `Orientation` into the clockwise degrees `sharp`
 * should apply, and knows nothing about files, S3 or Prodigi.
 */
export function printAssetRotation(orientation: Orientation): 0 | 90 {
  return orientation === "landscape" ? 90 : 0;
}

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
 * This is pure: it turns an `Orientation` into the clockwise degrees `sharp`
 * should apply, and knows nothing about files, S3 or Prodigi.
 */
export function printAssetRotation(orientation: Orientation): 0 | 90 {
  return orientation === "landscape" ? 90 : 0;
}

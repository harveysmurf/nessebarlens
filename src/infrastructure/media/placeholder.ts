/**
 * Placeholder-phase image resolution (#297).
 *
 * While `NEXT_PUBLIC_PLACEHOLDER_PHOTOS` is unset or `1`, every photo serves
 * a local `/placeholders/{slug}.jpg` JPEG instead of an R2 derivative URL, so
 * the gallery (and the print pages) never request derivatives that do not exist
 * yet. Set the variable to `0` to restore the R2 ladder for real prints.
 *
 * Both WebPhoto (the gallery tiles) and the print page resolve through here, so
 * the placeholder phase applies everywhere the image is rendered — not only the
 * gallery.
 */

import type { WebPhotoSource } from "./derivatives";
import type { GalleryImage } from "./gallery-image";
import { galleryImage } from "./gallery-image";
import { envString } from "@/infrastructure/config/env";
import type { WebDerivativeWidth } from "@/domain/catalog/derivative-ladder";

/** The placeholder phase is on by default; set `NEXT_PUBLIC_PLACEHOLDER_PHOTOS=0` to restore the R2 ladder. */
const placeholderPhase = (): boolean =>
  envString("NEXT_PUBLIC_PLACEHOLDER_PHOTOS") !== "0";

/** The placeholder JPEG for one slug. */
function placeholderImageFor(slug: string): GalleryImage {
  const placeholder = `/placeholders/${slug}.jpg`;
  return { src: placeholder, srcSet: placeholder, webpSrcSet: "" };
}

/** The image for one photo during the placeholder phase, or the real ladder once the phase is off. */
export function galleryImageOrPlaceholder(
  photo: WebPhotoSource,
  preferred?: WebDerivativeWidth,
): GalleryImage | null {
  if (placeholderPhase()) return placeholderImageFor(photo.slug);
  return galleryImage(photo, preferred);
}

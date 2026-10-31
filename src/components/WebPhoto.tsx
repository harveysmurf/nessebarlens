/**
 * Gallery / product preview as a `<picture>`.
 *
 * Placeholder phase (#297): the R2 derivative ladder has no public derivatives
 * yet, so the gallery serves local `/placeholders/{slug}.jpg` JPEGs and never
 * requests an empty R2 derivative URL. `NEXT_PUBLIC_PLACEHOLDER_PHOTOS` gates
 * the phase: unset or `1` serves placeholders; `0` restores the R2 ladder for
 * later real prints. The `galleryImage` helper is left in place for that later
 * phase.
 *
 * `preferred` names the derivative rung to use as the JPEG `src` — the largest
 * thing on the page passes the largest rung, a grid tile passes the middle one.
 * It does not narrow the srcSet; see lib/gallery-image.ts for why those are two
 * different questions.
 *
 * `sizes` applies because there is a real srcSet: an `img` with a srcSet and no
 * sizes makes the browser assume 100vw, which is wrong for a 33vw tile.
 *
 * The markup is PictureImg's; this component only resolves the ladder and the
 * alt-text fallback.
 */

import { galleryImage } from "@/infrastructure/media/gallery-image";
import type { WebDerivativeWidth } from "@/domain/catalog/derivative-ladder";
import type { Photo } from "@/domain/catalog/photos";
import { envString } from "@/infrastructure/config/env";
import { PictureImg } from "./PictureImg";

/** The placeholder phase is on by default; set `NEXT_PUBLIC_PLACEHOLDER_PHOTOS=0` to restore the R2 ladder. */
const placeholderPhase = (): boolean =>
  envString("NEXT_PUBLIC_PLACEHOLDER_PHOTOS") !== "0";

export function WebPhoto({
  photo,
  className,
  sizes = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 750px",
  preferred = 1500,
  priority = false,
}: {
  photo: Photo;
  className?: string | undefined;
  sizes?: string | undefined;
  preferred?: WebDerivativeWidth | undefined;
  priority?: boolean | undefined;
}) {
  const placeholder = `/placeholders/${photo.slug}.jpg`;

  if (placeholderPhase()) {
    // Placeholder phase: serve a local placeholder JPEG so the gallery is never
    // empty and never requests an empty R2 derivative URL, even when the base
    // and a photo hash would let the ladder build R2 URLs instead.
    return (
      <PictureImg
        image={{ src: placeholder, srcSet: placeholder, webpSrcSet: "" }}
        alt={photo.alt}
        className={className}
        sizes={sizes}
        priority={priority}
      />
    );
  }

  const image = galleryImage(photo, preferred);
  if (image === null) {
    // The ladder could not be built (an unusable slug, or no configured base):
    // render the alt text rather than request a file that is not there.
    return <span className={className}>{photo.alt}</span>;
  }

  return (
    <PictureImg
      image={image}
      alt={photo.alt}
      className={className}
      sizes={sizes}
      priority={priority}
    />
  );
}

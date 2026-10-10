/**
 * Gallery / product preview as a `<picture>`.
 *
 * Every published photo is served from the R2 derivative ladder (#245): a WebP
 * `<source>` and a JPEG `<img>` over the full four-rung srcset, so a browser
 * that supports WebP downloads it and one that does not falls back to the JPEG.
 * There is no placeholder image anymore.
 *
 * `preferred` names the derivative rung to use as the JPEG `src` — the largest
 * thing on the page passes the largest rung, a grid tile passes the middle one.
 * It does not narrow the srcSet; see lib/gallery-image.ts for why those are two
 * different questions.
 *
 * `sizes` applies because there is a real srcSet: an <img> with a srcSet and no
 * sizes makes the browser assume 100vw, which is wrong for a 33vw tile.
 *
 * The markup is PictureImg's; this component only resolves the ladder and the
 * alt-text fallback.
 */
import { galleryImage } from "@/infrastructure/media/gallery-image";
import type { WebDerivativeWidth } from "@/domain/catalog/derivative-ladder";
import type { Photo } from "@/domain/catalog/photos";
import { PictureImg } from "./PictureImg";

export function WebPhoto({
  photo,
  className,
  sizes = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 750px",
  preferred = 1500,
  priority = false,
}: {
  photo: Photo;
  className?: string;
  sizes?: string;
  preferred?: WebDerivativeWidth;
  priority?: boolean;
}) {
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

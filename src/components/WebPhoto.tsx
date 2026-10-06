/**
 * Gallery / product preview as a `<picture>`.
 *
 * When the photo has an image_hash and the ladder is on, this offers a WebP
 * `<source>` and a JPEG `<img>` over the full four-rung srcset, so a browser
 * that supports WebP downloads it and one that does not falls back to the
 * JPEG. Without a hash (a placeholder) there is one URL and no `<source>`.
 *
 * `preferred` names the derivative rung to use as the JPEG `src` — the largest
 * thing on the page passes the largest rung, a grid tile passes the middle one.
 * It does not narrow the srcSet; see lib/placeholder-photo.ts for why those are
 * two different questions.
 *
 * `sizes` also applies, and only when there is a real srcSet: an <img> with a
 * srcSet and no sizes makes the browser assume 100vw, which is wrong for a
 * 33vw tile. With no ladder there is a single URL and no sizes to declare.
 *
 * The `<picture>` is `display: contents`, so it generates no box and the <img>
 * is laid out exactly as it was before the wrapper existed (full-height tiles
 * depend on the percentage height resolving against the tile's own box).
 */
import { galleryImage } from "@/lib/placeholder-photo";
import type { WebDerivativeWidth } from "@/lib/derivative-ladder";
import type { Photo } from "@/lib/photos";

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
    // Not a safe path segment: render the alt text rather than request a
    // file that is not there.
    return <span className={className}>{photo.alt}</span>;
  }

  return (
    <picture className="contents">
      {image.webpSrcSet ? (
        <source type="image/webp" srcSet={image.webpSrcSet} sizes={sizes} />
      ) : null}
      <img
        src={image.src}
        {...(image.srcSet ? { srcSet: image.srcSet, sizes } : {})}
        alt={photo.alt}
        className={className}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        {...(priority ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

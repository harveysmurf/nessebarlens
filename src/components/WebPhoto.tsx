/**
 * Gallery / product preview.
 *
 * `preferred` names the derivative rung to use as the `src` — the largest thing
 * on the page passes the largest rung, a grid tile passes the middle one. It
 * does not narrow the srcSet; see lib/placeholder-photo.ts for why those are
 * two different questions.
 *
 * `sizes` also applies, and only when there is a real srcSet: an <img> with a
 * srcSet and no sizes makes the browser assume 100vw, which is wrong for a
 * 33vw tile. With no ladder there is a single URL and no sizes to declare.
 */
import { galleryImage } from "@/lib/placeholder-photo";
import type { WebDerivativeWidth } from "@/lib/derivative-ladder";

export function WebPhoto({
  slug,
  alt,
  className,
  sizes = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 750px",
  preferred = 1500,
  priority = false,
}: {
  slug: string;
  alt: string;
  className?: string;
  sizes?: string;
  preferred?: WebDerivativeWidth;
  priority?: boolean;
}) {
  const image = galleryImage(slug, preferred);
  if (image === null) {
    // Not a safe path segment: render the alt text rather than request a
    // file that is not there.
    return <span className={className}>{alt}</span>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- CDN derivatives and local placeholders, not next/image
    <img
      src={image.src}
      {...(image.srcSet ? { srcSet: image.srcSet, sizes } : {})}
      alt={alt}
      className={className}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      {...(priority ? { fetchPriority: "high" as const } : {})}
    />
  );
}

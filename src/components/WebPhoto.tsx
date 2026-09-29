/**
 * Gallery / product preview.
 *
 * `preferred` is accepted and deliberately not yet applied. It selects a rung
 * in the derivative ladder, and the rung set (750/1500/2500) stays as it is
 * until the real tile widths are measured — a prop that picked a rung from an
 * unmeasured set would be worse than one that visibly does nothing. It is
 * left in the signature so the call sites stay correct when it starts working;
 * do not delete it to "fix" the void, the honest fix is the real-prints task.
 *
 * `sizes` does apply, and only when there is a real srcSet: an <img> with a
 * srcSet and no sizes makes the browser assume 100vw, which is wrong for a
 * 33vw tile. With no ladder there is a single URL and no sizes to declare.
 */
import { galleryImage } from "@/lib/placeholder-photo";

export function WebPhoto({
  slug,
  alt,
  className,
  sizes = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 750px",
  preferred: _preferred = 1500,
  priority = false,
}: {
  slug: string;
  alt: string;
  className?: string;
  sizes?: string;
  preferred?: 750 | 1500 | 2500;
  priority?: boolean;
}) {
  void _preferred;
  const image = galleryImage(slug);
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

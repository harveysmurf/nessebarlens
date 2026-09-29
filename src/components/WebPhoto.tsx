/**
 * Gallery / product preview for the placeholder phase.
 * Serves committed JPEGs from /public/placeholders — not R2.
 *
 * `preferred` and `sizes` are accepted and deliberately not yet applied.
 * They are the hook the real derivative ladder plugs into
 * (lib/derivatives.ts → lib/placeholder-photo.ts), and they are left in the
 * signature on purpose so the call sites stay correct when that happens.
 * Until then every photo is one placeholder JPEG, so they cannot change the
 * output — a caller passing `preferred={2500}` gets the same image as one
 * passing nothing. That is a property of the placeholder phase, not a bug
 * to be cleaned away, so please do not delete these props to "fix" it;
 * the honest fix is to wire up the ladder, which is the real-prints task.
 */
import { placeholderPhotoImage } from "@/lib/placeholder-photo";

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
  void sizes;
  const image = placeholderPhotoImage(slug);
  if (image === null) {
    // Not a safe path segment: render the alt text rather than a request
    // for a file that is not there.
    return <span className={className}>{alt}</span>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- local placeholders, not next/image
    <img
      src={image.src}
      alt={alt}
      className={className}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      {...(priority ? { fetchPriority: "high" as const } : {})}
    />
  );
}

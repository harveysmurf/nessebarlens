/**
 * Gallery / product preview for the placeholder phase.
 * Serves committed JPEGs from /public/placeholders — not R2.
 * Derivative ladder (derivatives.ts) stays for real prints later.
 */
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
  // Bump when placeholder JPEGs change so browsers skip stale CDN copies.
  const src = `/placeholders/${slug}.jpg?v=3`;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- local placeholders, not next/image
    <img
      src={src}
      alt={alt}
      className={className}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      {...(priority ? { fetchPriority: "high" as const } : {})}
    />
  );
}

import { webDerivativeUrls } from "@/lib/derivatives";

type Props = {
  slug: string;
  alt: string;
  className?: string;
  sizes?: string;
  preferred?: 750 | 1500 | 2500;
  priority?: boolean;
};

/**
 * Gallery / product preview — public 750/1500/2500 only.
 * Plain img + srcset when NEXT_PUBLIC_WEB_IMAGES_BASE is set.
 * Otherwise a local empty matte (no remote host, no masters, no watermark, no right-click script).
 */
export function WebPhoto({
  slug,
  alt,
  className,
  sizes = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 750px",
  preferred = 1500,
  priority = false,
}: Props) {
  const urls = webDerivativeUrls(slug);

  if (!urls) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`bg-stone-200 ${className ?? ""}`}
      />
    );
  }

  const src =
    preferred === 750
      ? urls.w750
      : preferred === 2500
        ? urls.w2500
        : urls.w1500;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed derivative ladder, not next/image
    <img
      src={src}
      srcSet={urls.srcSet}
      sizes={sizes}
      alt={alt}
      className={className}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      {...(priority ? { fetchPriority: "high" as const } : {})}
    />
  );
}

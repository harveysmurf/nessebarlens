/**
 * The `<picture>` an image ladder renders to (#326).
 *
 * Extracted from WebPhoto so a client component (PrintPreview) can render the
 * same markup without importing `@/infrastructure/*`: the ladder URL is
 * computed on the server and passed in as a plain `GalleryImage`, and only the
 * `GalleryImage` *type* is imported here.
 *
 * The `<picture>` is `display: contents`, so it generates no box and the <img>
 * is laid out exactly as it was before the wrapper existed.
 */
import type { CSSProperties, ReactEventHandler, Ref } from "react";
import type { GalleryImage } from "@/infrastructure/media/gallery-image";

export function PictureImg({
  image,
  alt,
  className,
  sizes,
  priority = false,
  style,
  imgRef,
  onLoad,
}: {
  image: GalleryImage;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  style?: CSSProperties;
  /** The inner `<img>`, so a caller can read the URL the browser picked (#327). */
  imgRef?: Ref<HTMLImageElement | null>;
  onLoad?: ReactEventHandler<HTMLImageElement>;
}) {
  return (
    <picture className="contents">
      <source type="image/webp" srcSet={image.webpSrcSet} sizes={sizes} />
      <img
        ref={imgRef}
        onLoad={onLoad}
        src={image.src}
        srcSet={image.srcSet}
        sizes={sizes}
        alt={alt}
        className={className}
        style={style}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        {...(priority ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

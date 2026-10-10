import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintDetail } from "@/components/PrintDetail";
import { categoryHref, filmLookClass, getPhoto, PHOTOS } from "@/domain/catalog/photos";
import { galleryImage } from "@/infrastructure/media/gallery-image";

export function generateStaticParams() {
  return PHOTOS.map((p) => ({ slug: p.slug }));
}

export default async function PrintDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const photo = getPhoto(slug);
  if (!photo) notFound();

  // Resolved on the server: `galleryImage()` reads `process.env`, which a
  // client component does not see, so the ladder URL must be computed here and
  // passed down as a plain value (#326).
  const image = galleryImage(photo, 2000);
  const filmLookClassName = filmLookClass(photo.filmLook);

  return (
    <section className="fade-in max-w-7xl mx-auto px-6 py-10">
      <Link
        href={categoryHref(photo.category)}
        className="text-xs uppercase tracking-widest text-stone-500 hover:text-stone-900 mb-8 inline-flex items-center gap-2 font-medium"
      >
        ← Back to Gallery
      </Link>

      <PrintDetail
        photoSlug={photo.slug}
        title={photo.title}
        offer={photo.printOffer}
        master={photo.master}
        image={image}
        alt={photo.alt}
        filmLookClassName={filmLookClassName}
      >
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] font-mono font-medium text-amber-800">
            {photo.categoryLabel}
          </span>
          <h1 className="font-serif text-3xl font-normal text-stone-900 mt-1">
            {photo.title}
          </h1>
          <p className="text-xs text-stone-500 mt-2 leading-relaxed">
            {photo.description}
          </p>
        </div>
      </PrintDetail>
    </section>
  );
}

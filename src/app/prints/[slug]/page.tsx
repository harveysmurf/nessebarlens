import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintConfigurator } from "@/components/PrintConfigurator";
import { WebPhoto } from "@/components/WebPhoto";
import { categoryHref, filmLookClass, getPhoto, PHOTOS } from "@/domain/catalog/photos";

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

  const previewAspect = photo.master
    ? `${photo.master.width} / ${photo.master.height}`
    : "4 / 3";

  return (
    <section className="fade-in max-w-7xl mx-auto px-6 py-10">
      <Link
        href={categoryHref(photo.category)}
        className="text-xs uppercase tracking-widest text-stone-500 hover:text-stone-900 mb-8 inline-flex items-center gap-2 font-medium"
      >
        ← Back to Gallery
      </Link>

      <div className="grid lg:grid-cols-12 gap-12 items-start">
        <div className="lg:col-span-7 space-y-3">
          <div
            className="bg-stone-200 rounded-sm overflow-hidden relative flex items-center justify-center p-3 border border-stone-300/60 shadow-inner"
            style={{ aspectRatio: previewAspect }}
          >
            <WebPhoto
              photo={photo}
              preferred={2000}
              sizes="(max-width: 1024px) 100vw, 60vw"
              priority
              className={`max-h-full max-w-full object-contain shadow-md ${filmLookClass(photo.filmLook)}`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-stone-400 uppercase tracking-widest px-1">
            <span>Gallery preview</span>
            {photo.master && (
              <span>{photo.master.width} × {photo.master.height} px</span>
            )}
            <span>Global Delivery via Prodigi</span>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white p-8 rounded-sm border border-stone-200/80 shadow-sm space-y-6">
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

          <PrintConfigurator photoSlug={photo.slug} title={photo.title} />
        </div>
      </div>
    </section>
  );
}

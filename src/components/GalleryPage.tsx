import { PhotoCard } from "@/components/PhotoCard";
import type { Photo } from "@/lib/photos";
import { photosByCategory } from "@/lib/photos";
import type { PhotoCategory } from "@/lib/photo-schema";

const META: Record<
  PhotoCategory,
  { badge: string; badgeClass: string; title: string; blurb: string }
> = {
  "fine-art": {
    badge: "Curated Portfolio",
    badgeClass: "text-amber-800 bg-amber-100/60",
    title: "Fine Art Photography",
    blurb: "My flagship gallery captures • Printed on Hahnemühle Museum Rag via Prodigi",
  },
  archive: {
    badge: "Photojournalism",
    badgeClass: "text-blue-900 bg-blue-100/60",
    title: "Everyday Archive",
    blurb: "Street life, candid moments, and historic everyday events in Old Town Nessebar",
  },
  film: {
    badge: "Analog Negative",
    badgeClass: "text-emerald-900 bg-emerald-100/60",
    title: "Film Photography",
    blurb: "Authentic 35mm & 120 format film grain captures • Kodak, Leica & Hasselblad",
  },
};

export function GalleryPage({ category }: { category: PhotoCategory }) {
  const meta = META[category];
  const photos: Photo[] = photosByCategory(category);

  return (
    <section className="fade-in max-w-7xl mx-auto px-6 py-12">
      <div className="mb-10 text-center space-y-2">
        <span
          className={`text-[10px] uppercase tracking-[0.25em] px-2 py-0.5 rounded font-mono ${meta.badgeClass}`}
        >
          {meta.badge}
        </span>
        <h2 className="font-serif text-3xl font-light">{meta.title}</h2>
        <p className="text-xs text-stone-500">{meta.blurb}</p>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
        {photos.map((photo) => (
          <PhotoCard key={photo.slug} photo={photo} />
        ))}
      </div>
    </section>
  );
}

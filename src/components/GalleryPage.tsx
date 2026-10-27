import { PageShell } from "@/components/PageShell";
import { PhotoCard } from "@/components/PhotoCard";
import { CATEGORY } from "@/domain/catalog/categories";
import type { Photo } from "@/domain/catalog/photos";
import { photosByCategory } from "@/domain/catalog/photos";
import type { PhotoCategory } from "@/domain/catalog/photo-schema";
import type { Locale } from "@/domain/i18n/locale";

/**
 * The gallery's own copy: the badge, its colour, and the blurb. The heading is
 * not here — `CATEGORY[category].galleryTitle` owns it (#421), so the gallery and
 * the nav cannot spell the category differently by accident.
 */
const META: Record<PhotoCategory, { badge: string; badgeClass: string; blurb: string }> = {
  "fine-art": {
    badge: "Curated Portfolio",
    badgeClass: "text-amber-800 bg-amber-100/60",
    blurb:
      "My flagship gallery captures • Museum-quality giclée prints via Prodigi • Available on Hahnemühle Photo Rag",
  },
  archive: {
    badge: "Photojournalism",
    badgeClass: "text-blue-900 bg-blue-100/60",
    blurb: "Street life, candid moments, and historic everyday events in Old Town Nessebar",
  },
  film: {
    badge: "Analog Negative",
    badgeClass: "text-emerald-900 bg-emerald-100/60",
    blurb: "35mm film photographs shot on my Nikon F3 • Kentmere Pan 100",
  },
};

export function GalleryPage({
  category,
  locale,
}: {
  category: PhotoCategory;
  /** The locale of the page: every print the gallery links to carries it. */
  locale: Locale;
}) {
  const meta = META[category];
  const photos: Photo[] = photosByCategory(category);

  return (
    <section className="fade-in">
      <PageShell width="7xl" padding={12}>
        <div className="mb-10 text-center space-y-2">
          <span
            className={`text-[10px] uppercase tracking-[0.25em] px-2 py-0.5 rounded font-mono ${meta.badgeClass}`}
          >
            {meta.badge}
          </span>
          <h2 className="font-serif text-3xl font-light">
            {CATEGORY[category].galleryTitle}
          </h2>
          <p className="text-xs text-stone-500">{meta.blurb}</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {photos.map((photo) => (
            <PhotoCard key={photo.slug} photo={photo} locale={locale} />
          ))}
        </div>
      </PageShell>
    </section>
  );
}

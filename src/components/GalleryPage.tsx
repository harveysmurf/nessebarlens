import { PageShell } from "@/components/PageShell";
import { PhotoCard } from "@/components/PhotoCard";
import { categoryNames } from "@/domain/catalog/categories";
import type { Photo } from "@/domain/catalog/photos";
import { photoForLocale, photosByCategory } from "@/domain/catalog/photos";
import type { PhotoCategory } from "@/domain/catalog/photo-schema";
import type { Locale } from "@/domain/i18n/locale";
import type { Dictionary } from "@/components/i18n/dictionaries";

/**
 * The gallery's badge colour, per category.
 *
 * The badge's *words* are copy and live in the dictionary, with the rest of the
 * gallery's words; the colour is not copy and stays here, because a colour has
 * no translation and a class name is not a sentence.
 */
const BADGE_CLASS: Record<PhotoCategory, { badgeClass: string }> = {
  "fine-art": { badgeClass: "text-amber-800 bg-amber-100/60" },
  archive: { badgeClass: "text-blue-900 bg-blue-100/60" },
  film: { badgeClass: "text-emerald-900 bg-emerald-100/60" },
};

export function GalleryPage({
  category,
  locale,
  copy,
  printOptions,
}: {
  category: PhotoCategory;
  /** The locale of the page: every print the gallery links to carries it. */
  locale: Locale;
  /** The gallery's own words, in the page's language. */
  copy: Dictionary["gallery"];
  /** The gallery card's price-column label, in the page's language. */
  printOptions: string;
}) {
  const meta = BADGE_CLASS[category];
  // The photos are the catalog's, localized for this page: the shared catalog
  // holds the source's words, and the gallery shows the reader's.
  const photos: Photo[] = photosByCategory(category).map((photo) =>
    photoForLocale(photo, locale),
  );

  return (
    <section className="fade-in">
      <PageShell width="7xl" padding={12}>
        <div className="mb-10 text-center space-y-2">
          <span
            className={`text-[10px] uppercase tracking-[0.25em] px-2 py-0.5 rounded font-mono ${meta.badgeClass}`}
          >
            {copy.badge[category]}
          </span>
          <h2 className="font-serif text-3xl font-light">
            {categoryNames(category, locale).galleryTitle}
          </h2>
          <p className="text-xs text-stone-500">{copy.blurb[category]}</p>
        </div>
        {photos.length === 0 ? (
          <p className="text-center text-sm text-stone-500">{copy.empty}</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {photos.map((photo) => (
              <PhotoCard
                key={photo.slug}
                photo={photo}
                locale={locale}
                printOptions={printOptions}
              />
            ))}
          </div>
        )}
      </PageShell>
    </section>
  );
}

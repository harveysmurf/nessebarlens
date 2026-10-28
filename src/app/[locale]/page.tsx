import type { Metadata } from "next";
import Link from "next/link";
import { HOME_CATEGORY_GRID_SIZES } from "@/components/grid-sizes";
import { PhotoTile } from "@/components/PhotoTile";
import { WebPhoto } from "@/components/WebPhoto";
import { categoryNames, CATEGORY } from "@/domain/catalog/categories";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@/domain/catalog/photo-schema";
import {
  featuredPhoto,
  photoForLocale,
  photosByCategory,
} from "@/domain/catalog/photos";
import { isLocale, type Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { eyebrowClass } from "@/components/type-styles";
import { PageShell } from "@/components/PageShell";
import { getDictionary, type Dictionary } from "@/components/i18n/dictionaries";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "./locale-param";

/**
 * The home page's own title and canonical. The layout carries the same pair for
 * the fallback case (a page that exports nothing), which is why both read from
 * `HOME_COPY` rather than one copying the other's string.
 *
 * A function rather than a constant because the canonical carries the locale
 * segment: the page is served at `/en` or `/bg`, and only one of those is the
 * URL this metadata is about.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return pageMetadata("/", locale);
}

/**
 * One tile per category, in `PHOTO_CATEGORIES`' display order, so the "01"
 * numbering is derived from the catalog rather than typed a second time — it
 * was typed here and again on /story, and those two had to be edited in step.
 *
 * The href, the heading and the blurb are the registry's and the dictionary's
 * respectively; what is left here is the number, which is derived. Adding a
 * category still means adding its blurb, and that is a compile error in the
 * dictionary — which is the point.
 */
function tiles(
  locale: Locale,
  copy: Dictionary,
): Array<{
  category: PhotoCategory;
  href: string;
  title: string;
  n: string;
  blurb: string;
}> {
  return PHOTO_CATEGORIES.map((category, i) => ({
    category,
    href: CATEGORY[category].href,
    title: categoryNames(category, locale).homeTitle,
    n: String(i + 1).padStart(2, "0"),
    blurb: copy.home.tileBlurb[category],
  }));
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);
  const copy = getDictionary(locale);
  // The hero and the tiles are the catalog's photos, read in this page's
  // language: the shared catalog holds the source's words.
  const hero = photoForLocale(featuredPhoto()!, locale);

  return (
    <section className="fade-in">
      <PageShell
        width="7xl"
        padding={10}
        // The only shell whose two ends differ: 10 below the sticky header, 16
        // under the footer. `pb-16` after `py-10` wins because Tailwind emits
        // them in that order at the same specificity — `page-shell.test.mts`
        // asserts that in the compiled stylesheet.
        className="pb-16 space-y-16"
      >
        <Link
          href={localePath(locale, `/prints/${hero.slug}`)}
          className="relative aspect-[21/9] rounded-sm overflow-hidden bg-gallery-200 group block"
        >
          <WebPhoto
            photo={hero}
            preferred={2000}
            priority
            sizes="(max-width: 1280px) 100vw, 1280px"
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-1000"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-gallery-900/80 via-transparent to-transparent flex items-end p-8 sm:p-12">
            <div className="text-white space-y-1">
              <span className={eyebrowClass('accent')}>
                {copy.home.heroEyebrow}
              </span>
              <h1 className="font-serif text-3xl sm:text-5xl font-light">
                {hero.title}
              </h1>
              {hero.heroCaption && (
                <p className="text-xs text-stone-300 font-light max-w-md">
                  {hero.heroCaption}
                </p>
              )}
            </div>
          </div>
        </Link>

        <div className="text-center max-w-2xl mx-auto space-y-3 py-4">
          <p className="font-serif text-2xl sm:text-3xl font-light leading-relaxed text-stone-800 italic">
            &ldquo;{copy.home.heroBody}&rdquo;
          </p>
          <div className="w-12 h-[1px] bg-stone-300 mx-auto" />
          <p className="text-[10px] uppercase tracking-widest text-stone-500 pt-2">
            {copy.home.preferStory}{" "}
            <Link
              href={localePath(locale, "/story")}
              className="underline hover:text-stone-800"
            >
              {copy.home.viewConceptB}
            </Link>
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {tiles(locale, copy).map((cat) => {
            // The first real photo in the category is the tile image; a category
            // with no published photo yet renders the tile without an image
            // rather than pointing at a placeholder that no longer exists (#245).
            const photo = photosByCategory(cat.category)[0];
            return (
              <Link
                key={cat.href}
                href={localePath(locale, cat.href)}
                className="group space-y-3 block"
              >
                <PhotoTile
                  photo={photo && photoForLocale(photo, locale)}
                  sizes={HOME_CATEGORY_GRID_SIZES}
                />
                <div className="border-b border-gallery-200 pb-3 flex justify-between items-baseline gap-3">
                  <div>
                    <h3 className="font-serif text-xl font-normal">
                      {cat.n}. {cat.title}
                    </h3>
                    <p className="text-[11px] text-stone-500">{cat.blurb}</p>
                  </div>
                  <span className="text-[10px] uppercase tracking-widest text-stone-800 font-medium group-hover:underline shrink-0">
                    {copy.home.explore}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </PageShell>
    </section>
  );
}

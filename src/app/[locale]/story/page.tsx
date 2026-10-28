import type { Metadata } from "next";
import Link from "next/link";
import { STORY_BLOCK_SIZES } from "@/components/grid-sizes";
import { PhotoTile } from "@/components/PhotoTile";
import { categoryNames, CATEGORY } from "@/domain/catalog/categories";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@/domain/catalog/photo-schema";
import { photoForLocale, photosByCategory } from "@/domain/catalog/photos";
import { isLocale, type Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { BODY_COPY, eyebrowClass } from "@/components/type-styles";
import { PageShell } from "@/components/PageShell";
import { getDictionary, type Dictionary } from "@/components/i18n/dictionaries";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../locale-param";

/**
 * The route's own words, from the one table in `page-metadata.ts`, for the
 * language this page is in.
 *
 * A function rather than a constant because the canonical now carries the locale
 * segment.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return pageMetadata("/story", locale);
}

/**
 * Which blocks are flipped.
 *
 * The layout is not copy and not a fact about a category: it is how this page
 * arranges the three, so it is declared here rather than in the dictionary or
 * in the registry.
 */
const FLIPPED: Record<PhotoCategory, boolean> = {
  "fine-art": false,
  archive: true,
  film: false,
};

/**
 * One block per category, in `PHOTO_CATEGORIES`' display order (#421).
 *
 * The href and the heading are the registry's — this is the surface where "Fine
 * Art" and "Fine Art Collection" were most obviously two different sentences,
 * so the difference is declared rather than averaged away — and the body and
 * the call to action are the dictionary's.
 */
function blocks(
  locale: Locale,
  copy: Dictionary,
): Array<{
  category: PhotoCategory;
  href: string;
  title: string;
  n: string;
  body: string;
  cta: string;
  flip: boolean;
}> {
  return PHOTO_CATEGORIES.map((category, i) => ({
    category,
    href: CATEGORY[category].href,
    title: categoryNames(category, locale).storyTitle,
    n: String(i + 1).padStart(2, "0"),
    body: copy.story.blockBody[category],
    cta: copy.story.blockCta[category],
    flip: FLIPPED[category],
  }));
}

export default async function StoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);
  const copy = getDictionary(locale);
  const list = blocks(locale, copy);

  return (
    <section className="fade-in">
      <PageShell width="5xl" padding={16} className="space-y-20">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <span className={eyebrowClass()}>
            {copy.story.eyebrow}
          </span>
          <h1 className="font-serif text-4xl sm:text-6xl font-light">
            {copy.story.title}
          </h1>
          <p className={BODY_COPY}>
            {copy.story.body}
          </p>
        </div>

        {list.map((block, i) => {
          // The first real photo in the category is the block image; a category
          // with no published photo yet renders without an image rather than
          // pointing at a placeholder that no longer exists (#245).
          const photo = photosByCategory(block.category)[0];
          return (
            <div
              key={block.href}
              className={`grid md:grid-cols-12 gap-8 items-center ${
                i < list.length - 1 ? "border-b border-gallery-200/80 pb-12" : ""
              }`}
            >
              <div
                className={`md:col-span-7 ${
                  block.flip ? "md:order-2 order-1" : ""
                }`}
              >
                {/* #409: no padding utility here either — that padding is what
                    drew a 4px black frame around the film blocks. The backdrop
                    itself moved into `PhotoTile` (#422). */}
                <Link href={localePath(locale, block.href)} className="block">
                  <PhotoTile
                    photo={photo && photoForLocale(photo, locale)}
                    ratio="3/2"
                    sizes={STORY_BLOCK_SIZES}
                  />
                </Link>
              </div>
              <div
                className={`md:col-span-5 space-y-3 ${
                  block.flip ? "md:order-1 order-2" : ""
                }`}
              >
                <span className="text-[10px] uppercase tracking-widest text-stone-500 font-mono">
                  {copy.story.categoryLabel} {block.n}
                </span>
                <h2 className="font-serif text-2xl font-normal">{block.title}</h2>
                <p className={BODY_COPY}>
                  {block.body}
                </p>
                <Link
                  href={localePath(locale, block.href)}
                  className="inline-block text-[11px] uppercase tracking-widest text-stone-900 font-medium hover:underline pt-2"
                >
                  {block.cta}
                </Link>
              </div>
            </div>
          );
        })}
      </PageShell>
    </section>
  );
}

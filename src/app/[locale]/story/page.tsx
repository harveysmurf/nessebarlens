import type { Metadata } from "next";
import Link from "next/link";
import { STORY_BLOCK_SIZES } from "@/components/grid-sizes";
import { PhotoTile } from "@/components/PhotoTile";
import { CATEGORY } from "@/domain/catalog/categories";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@/domain/catalog/photo-schema";
import { photosByCategory } from "@/domain/catalog/photos";
import { isLocale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { BODY_COPY, eyebrowClass } from "@/components/type-styles";
import { PageShell } from "@/components/PageShell";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../locale-param";

/**
 * The route's own words, from the one table in `page-metadata.ts`, for the
 * language this page is in.
 *
 * A function rather than a constant because the canonical now carries the
 * locale segment.
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
 * The /story block's own copy. The href and the heading are the registry's
 * (#421) — this is the surface where "Fine Art" and "Fine Art Collection" were
 * most obviously two different sentences, so the difference is declared rather
 * than averaged away.
 */
const BLOCK_COPY: Record<
  PhotoCategory,
  { body: string; cta: string; flip: boolean }
> = {
  "fine-art": {
    body: "My highest-grade artistic works. Carefully composed architecture, dramatic atmospheric coastlines, and pristine color grading tailored for museum Giclée prints.",
    cta: "Browse Fine Art Gallery →",
    flip: false,
  },
  archive: {
    body: "Photojournalistic records of Nessebar's daily soul — fishermen untangling nets at sunrise, autumn cobblers, seasonal storms, and local town life.",
    cta: "Browse Archival Gallery →",
    flip: true,
  },
  film: {
    body: "35mm film photographs shot on my Nikon F3, with the natural grain and character of Kentmere Pan 100.",
    cta: "Browse Film Gallery →",
    flip: false,
  },
};

/** One block per category, in `PHOTO_CATEGORIES`' display order (#421). */
const BLOCKS = PHOTO_CATEGORIES.map((category, i) => ({
  category,
  href: CATEGORY[category].href,
  title: CATEGORY[category].storyTitle,
  n: String(i + 1).padStart(2, "0"),
  ...BLOCK_COPY[category],
}));

export default async function StoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);

  return (
    <section className="fade-in">
      <PageShell width="5xl" padding={16} className="space-y-20">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <span className={eyebrowClass()}>
            Visual Heritage
          </span>
          <h1 className="font-serif text-4xl sm:text-6xl font-light">
            Stories from the Black Sea Peninsula
          </h1>
          <p className={BODY_COPY}>
            A clean, unhurried collection of prints captured over decades.
            High-resolution fine art, historical street photojournalism, and
            35mm film photographs shot on a Nikon F3.
          </p>
        </div>

        {BLOCKS.map((block, i) => {
          // The first real photo in the category is the block image; a category
          // with no published photo yet renders without an image rather than
          // pointing at a placeholder that no longer exists (#245).
          const photo = photosByCategory(block.category)[0];
          return (
            <div
              key={block.href}
              className={`grid md:grid-cols-12 gap-8 items-center ${
                i < BLOCKS.length - 1 ? "border-b border-gallery-200/80 pb-12" : ""
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
                  <PhotoTile photo={photo} ratio="3/2" sizes={STORY_BLOCK_SIZES} />
                </Link>
              </div>
              <div
                className={`md:col-span-5 space-y-3 ${
                  block.flip ? "md:order-1 order-2" : ""
                }`}
              >
                <span className="text-[10px] uppercase tracking-widest text-stone-500 font-mono">
                  CATEGORY {block.n}
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

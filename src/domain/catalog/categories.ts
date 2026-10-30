import { DEFAULT_LOCALE, type Locale } from "../i18n/locale";
import { PHOTO_CATEGORIES, type PhotoCategory } from "./photo-schema";

/**
 * Every category fact the UI reads that is not specific to one surface (#421).
 *
 * Before this, the three categories were named in six places — `CATEGORY_LABEL`
 * and `CATEGORY_HREF` in `photos.ts`, `NAV` in `components/nav.ts`, `META` in
 * `components/GalleryPage.tsx`, `CATEGORIES` on the home page, `BLOCKS` on
 * /story, and the header tagline's JSX text in `SiteHeader` *and* again in
 * `MobileNav`. `fine-art` rendered as "Fine Art", "Fine Art Photography",
 * "Fine Art Collection" and "Fine Art" again in the tagline; `archive` as
 * "Archive", "Everyday Archive" and "Everyday Archive • Photojournalism". Only
 * `film` was spelled the same in all five *tables* — in the tagline it was
 * "Film" — and even that was luck.
 *
 * One `Record` rather than a `switch`: a switch falls off the end when a
 * category is added, so the new one would type-check and render `undefined`.
 * Here it is a compile error in one place instead.
 *
 * **The names are declared, not converged.** One field per surface, because
 * "Fine Art" in a nav bar and "Fine Art Collection" on a print are different
 * sentences, not a spelling mistake. Which of them currently coincide is a fact
 * `tests/category-registry.test.mts` pins, so if one surface's copy changes the
 * test says which pair diverged instead of the difference appearing silently.
 * Collapsing any pair to a single field is then a one-line change here.
 *
 * Copy that genuinely differs sentence-to-sentence — the gallery blurb, the
 * homepage tile blurb, the story block body and CTA, the gallery badge and its
 * colour — stays at the caller that renders it. This record holds what is the
 * same everywhere, not everything anyone ever wrote about a category.
 *
 * **The names are per locale, and the route is not.** The href is a route, so
 * it is one string for every language: `/fine-art` is `/fine-art` in Bulgarian
 * too, and a second href per language is a second source of truth about where
 * a page lives. The *names* are copy, so they are declared per locale, and a
 * locale added without them is a compile error here rather than an `undefined`
 * in the nav.
 */
export type CategoryNames = {
  /** What the desktop and mobile nav call it. */
  navLabel: string;
  /** The gallery page's heading. */
  galleryTitle: string;
  /** The homepage tile's heading. */
  homeTitle: string;
  /** The /story block's heading. */
  storyTitle: string;
  /**
   * The shortest of the declared names, for the header's one-line tagline, which
   * lists all three and has no room for "Fine Art Photography". A sixth field
   * rather than a truncation of `navLabel`: the tagline abbreviating itself
   * would be an accident wearing a rule's clothes.
   */
  taglineName: string;
  /** A print's category line — `photo.categoryLabel`, in the catalog. */
  printLabel: string;
};

export type CategoryFacts = {
  /** The gallery route. The one href a category has, in every locale. */
  href: string;
  /** The names, per locale. */
  names: Record<Locale, CategoryNames>;
};

/** Every category fact, keyed by the category the facts are about. */
export const CATEGORY: Record<PhotoCategory, CategoryFacts> = {
  "fine-art": {
    href: "/fine-art",
    names: {
      en: {
        navLabel: "Fine Art",
        galleryTitle: "Fine Art Photography",
        homeTitle: "Fine Art",
        storyTitle: "Fine Art Collection",
        taglineName: "Fine Art",
        printLabel: "Fine Art Collection",
      },
      bg: {
        navLabel: "Художествена фотография",
        galleryTitle: "Художествена фотография",
        homeTitle: "Художествена фотография",
        storyTitle: "Колекция художествени фотографии",
        taglineName: "Художествена фотография",
        printLabel: "Художествена фотография",
      },
    },
  },
  archive: {
    href: "/archive",
    names: {
      en: {
        navLabel: "Archive",
        galleryTitle: "Everyday Archive",
        homeTitle: "Archive",
        storyTitle: "Everyday Archive",
        taglineName: "Archive",
        printLabel: "Everyday Archive • Photojournalism",
      },
      bg: {
        navLabel: "Архив",
        galleryTitle: "Архив на ежедневието",
        homeTitle: "Архив",
        storyTitle: "Архив на ежедневието",
        taglineName: "архив",
        printLabel: "Архив на ежедневието · Документална фотография",
      },
    },
  },
  film: {
    href: "/film",
    names: {
      en: {
        navLabel: "Film Photography",
        galleryTitle: "Film Photography",
        homeTitle: "Film Photography",
        storyTitle: "Film Photography",
        taglineName: "Film",
        printLabel: "Film Photography",
      },
      bg: {
        navLabel: "Филмова фотография",
        galleryTitle: "Филмова фотография",
        homeTitle: "Филмова фотография",
        storyTitle: "Филмова фотография",
        taglineName: "филмова фотография",
        printLabel: "Филмова фотография",
      },
    },
  },
};

/**
 * The word that joins the last two names in the header's tagline.
 *
 * Bulgarian joins a list with "и", English with "&". The list format is the
 * site's, and the two languages do not spell it the same way, so the joiner is
 * part of the localized names rather than a constant in the code.
 */
const TAGLINE_JOIN: Record<Locale, string> = { en: " & ", bg: " и " };

/**
 * The categories as the header's tagline lists them: `Fine Art, Archive & Film`.
 *
 * This was the sixth table, and the only one the compiler could not help with —
 * it was JSX text, in `SiteHeader` and again in `MobileNav`, where the two had
 * stayed in step only because #331 made them share one array. Joining here means
 * a fourth category joins this line too, instead of quietly going missing from
 * one of two hand-typed copies of the same sentence.
 *
 * `Old Town Nessebar •` stays at the call sites: that is the town, not a
 * category, and the domain is not where the site's address lives.
 */
export function categoryTagline(locale: Locale = DEFAULT_LOCALE): string {
  const names = PHOTO_CATEGORIES.map(
    (category) => CATEGORY[category].names[locale].taglineName,
  );
  // A, B and C — the site's list format, and the reason this cannot just be
  // `names.join(", ")`.
  return `${names.slice(0, -1).join(", ")}${TAGLINE_JOIN[locale]}${names[names.length - 1]}`;
}

export function categoryHref(category: PhotoCategory): string {
  return CATEGORY[category].href;
}

/** A category's names in one locale. */
export function categoryNames(
  category: PhotoCategory,
  locale: Locale = DEFAULT_LOCALE,
): CategoryNames {
  return CATEGORY[category].names[locale];
}

/** A print's category line, in one locale. */
export function categoryLabel(
  category: PhotoCategory,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return CATEGORY[category].names[locale].printLabel;
}

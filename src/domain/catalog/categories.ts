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
 */
export type CategoryFacts = {
  /** The gallery route. The one href a category has. */
  href: string;
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

/** Every category fact, keyed by the category the facts are about. */
export const CATEGORY: Record<PhotoCategory, CategoryFacts> = {
  "fine-art": {
    href: "/fine-art",
    navLabel: "Fine Art",
    galleryTitle: "Fine Art Photography",
    homeTitle: "Fine Art",
    storyTitle: "Fine Art Collection",
    taglineName: "Fine Art",
    printLabel: "Fine Art Collection",
  },
  archive: {
    href: "/archive",
    navLabel: "Archive",
    galleryTitle: "Everyday Archive",
    homeTitle: "Archive",
    storyTitle: "Everyday Archive",
    taglineName: "Archive",
    printLabel: "Everyday Archive • Photojournalism",
  },
  film: {
    href: "/film",
    navLabel: "Film Photography",
    galleryTitle: "Film Photography",
    homeTitle: "Film Photography",
    storyTitle: "Film Photography",
    taglineName: "Film",
    printLabel: "Film Photography",
  },
};

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
export const CATEGORY_TAGLINE = (() => {
  const names = PHOTO_CATEGORIES.map((category) => CATEGORY[category].taglineName);
  // A, B & C — the site's list format, and the reason this cannot just be
  // `names.join(", ")`.
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
})();

export function categoryHref(category: PhotoCategory): string {
  return CATEGORY[category].href;
}

export function categoryLabel(category: PhotoCategory): string {
  return CATEGORY[category].printLabel;
}
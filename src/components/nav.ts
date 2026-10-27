import { CATEGORY } from "@/domain/catalog/categories";
import { PHOTO_CATEGORIES } from "@/domain/catalog/photo-schema";
import type { Locale } from "@/domain/i18n/locale";

/**
 * The site's primary navigation, shared by the desktop inline nav and the
 * mobile menu so the two can never drift (#331).
 *
 * The category entries take their href and their label from the one category
 * registry (#421), so this is the only place a nav label is written down — a
 * third nav cannot introduce a fourth spelling. That is drift, not agreement:
 * #421 declared `navLabel` and `galleryTitle` as separate names because "Fine
 * Art" in a nav bar and "Fine Art Photography" on a gallery are different
 * sentences, and this change did not merge them.
 *
 * The label is the locale's: the registry declares a name per locale, so the
 * nav says "Финиарт" under a Bulgarian URL without a second table here.
 *
 * `Contact` is not a category, so it has no entry in the registry, and its
 * label is copy: it comes from the dictionary and is passed in, because this
 * module is imported by the client and the dictionary is not.
 */
export function navFor(
  locale: Locale,
  contactLabel: string,
): Array<{ href: string; label: string }> {
  return [
    ...PHOTO_CATEGORIES.map((category) => ({
      href: CATEGORY[category].href,
      label: CATEGORY[category].names[locale].navLabel,
    })),
    { href: "/contact", label: contactLabel },
  ];
}

/** A route is current when it is a link's target or a descendant of it. */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * One table of what every route says about itself, and the helper that turns a
 * row into `Metadata`.
 *
 * Before this, `layout.tsx` exported the only `metadata` in the app, so every
 * route rendered the same `<title>Nessebar Lens</title>` and the same
 * description — the root's. A page that exported its own replaced the whole
 * object field-for-field, so a hand-written `metadata` on `/contact` silently
 * dropped the OG and Twitter blocks as well as `metadataBase`, and `/film`,
 * `/fine-art`, `/archive` and every print shipped the homepage's words.
 *
 * Two things live here rather than at the call sites, for the same reason
 * `categories.ts` holds what a category is called everywhere:
 *
 *   - The copy. `PAGE_COPY` is keyed by the route path, so a route's title and
 *     description are declared once, and `tests/seo-metadata.test.mts` can read
 *     the whole site without importing React or a page module.
 *   - The shape. `pageMetadata()` returns the *complete* object — title,
 *     description, canonical, and the OG/Twitter fields the root sets. A page
 *     that adds only a title would otherwise inherit the root's description,
 *     which is how "Nessebar Lens — Fine Art Photography" ended up described as
 *     archive and film as well.
 *
 * The canonical is absolute and built from `configuredSiteUrl()`, so there is
 * one spelling of the origin — the same reader `siteUrl()` and the Stripe origin
 * use. The `http://localhost:3000` fallback matches that of `metadataBase` in
 * `layout.tsx` and only applies when the variable is unset, which a production
 * build refuses to be (`next.config.ts`).
 */

import type { Metadata } from "next";
import { CATEGORY } from "@/domain/catalog/categories";
import { photoForLocale } from "@/domain/catalog/photos";
import type { PhotoCategory } from "@/domain/catalog/photo-schema";
import { DEFAULT_LOCALE, PUBLIC_LOCALES, type Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { configuredSiteUrl, type ConfigEnv } from "../config/config";
import { NODE_ENV } from "../config/env";

/** The site's name, and the suffix every title carries. */
export const SITE_TITLE = "Nessebar Lens";

/**
 * The homepage's description. Module-private: `HOME_COPY` is the only way to
 * reach it, and `tests/zero-ref-exports.test.mts` holds this repo to no export
 * that nothing outside its module reads.
 */
const SITE_DESCRIPTION =
  "Fine art, archive, and film photography from Old Town Nessebar. Museum-quality prints and digital downloads.";

/** A root-relative path; `metadataBase` makes it absolute for the crawlers. */
export const OG_IMAGE = "/og-image.jpg";

/**
 * The dev origin `metadataBase` already falls back to. Kept in one place so a
 * canonical built here and a canonical built by Next's `metadataBase` resolution
 * are the same string in development.
 */
const FALLBACK_ORIGIN = "http://localhost:3000";

/** The configured origin, or the dev fallback. Never throws. */
export function seoOrigin(env: ConfigEnv = NODE_ENV): string {
  return configuredSiteUrl(env) ?? FALLBACK_ORIGIN;
}

/**
 * The absolute URL for a site route.
 *
 * The site root keeps a trailing slash here — `https://nessebarlens.com/` is the
 * URL, and `https://nessebarlens.com` is the same one by RFC 3986 normalisation.
 * Worth knowing that Next does not pass it through: its metadata resolver
 * rewrites a root URL to `result.origin`
 * (`node_modules/next/dist/lib/metadata/resolvers/resolve-url.js`), so the
 * rendered `<link rel="canonical" href="https://nessebarlens.com">` has no
 * trailing slash. That is deliberate on Next's part and harmless for a crawler,
 * which is why this helper keeps the readable form and the sitemap lists `/`.
 * Both surfaces are self-consistent; the two differ by the separator and mean
 * the same page.
 */
export function canonicalUrl(route: string, env: ConfigEnv = NODE_ENV): string {
  const origin = seoOrigin(env);
  if (route === "/") return `${origin}/`;
  // A leading slash is the site's own convention (`CATEGORY[].href`, `NAV`).
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${origin}${path}`;
}

/**
 * The `hreflang` cluster for one locale-relative route.
 *
 * One entry per served locale, each pointing at that locale's own URL, plus
 * `x-default` on the default locale — the page a crawler should show when no
 * language matches. The entries are built from `PUBLIC_LOCALES`, never from a
 * list here: a locale this build does not serve has no page to point at, and an
 * alternate that answers 404 is a broken cluster.
 */
export function languageAlternates(
  route: string,
  env: ConfigEnv = NODE_ENV,
): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of PUBLIC_LOCALES) {
    languages[locale] = canonicalUrl(localePath(locale, route), env);
  }
  languages["x-default"] = canonicalUrl(localePath(DEFAULT_LOCALE, route), env);
  return languages;
}

/**
 * What one route says. `description` is the crawler's summary of the page; every
 * route needs its own, because a shared one is the bug this module exists to
 * fix.
 */
export type PageCopy = {
  /** Unique per route, and 50–65 characters for an indexed route. */
  title: string;
  description: string;
  /**
   * False for a page a crawler must not keep: the checkout pages, which are
   * per-session and hold an order reference in the URL. They are also left out
   * of the sitemap, from the same flag, so "not indexed" is one decision rather
   * than two that can disagree.
   */
  index?: boolean;
};

/**
 * The homepage's own words, named because `layout.tsx` needs them and the root
 * layout cannot read a child page segment's metadata. `PAGE_COPY["/"]` *is* this
 * object — it is the same reference, not a copy — and
 * `tests/seo-metadata.test.mts` asserts the two are identical so the pinning
 * holds if the table is ever rebuilt.
 */
export const HOME_COPY: PageCopy = {
  title: "Nessebar Lens — Fine Art Photography Prints from Nessebar",
  description: SITE_DESCRIPTION,
};

/**
 * Every route in `src/app` that has a `page.tsx`, keyed by route path. The
 * dynamic print route is listed under its segment (`/prints/[slug]`) and gets
 * its title from the photo, via `printMetadata`.
 *
 * The titles are a proposal and Simo may rewrite them; what the test holds is
 * that they are unique, and 50–65 characters for the indexed routes. Google
 * truncates in the SERP around 60, and a title shorter than ~50 leaves the
 * highest-converting words unsaid.
 *
 * `checkout/cancel` and `checkout/success` are below the length floor on
 * purpose: nobody searches for a cancelled checkout, and lengthening a title to
 * pass a check would be the filler this issue explicitly refuses to add.
 */
export const PAGE_COPY: Record<string, PageCopy> = {
  "/": HOME_COPY,
  "/fine-art": {
    title: "Fine Art Prints — Museum-Quality Photography from Nessebar",
    description:
      "Curated fine art photographs of Old Town Nessebar, printed museum-quality on Hahnemühle Photo Rag or delivered as a high-resolution digital file.",
  },
  "/film": {
    title: "35mm Film Photography — Nikon F3 from Old Town Nessebar",
    description:
      "35mm black-and-white film photographs from Old Town Nessebar, Bulgaria, shot on a Nikon F3 with Kentmere Pan 100.",
  },
  "/archive": {
    title: "Archive — Everyday Street Photography from Old Town Nessebar",
    description:
      "Everyday street and photojournalistic photographs from Old Town Nessebar: fishermen at sunrise, autumn cobblers, seasonal storms, and ordinary town life.",
  },
  "/story": {
    title: "Our Story — Three Decades of Photography in Nessebar",
    description:
      "How three decades of coastal light, street memory, and analog film grain became the Nessebar Lens archive, and how each print is made and delivered.",
  },
  "/contact": {
    title: "Contact the Studio — Prints, Licensing & Orders, Nessebar",
    description:
      "Questions about a print, a licence, or an order? Message the Nessebar Lens studio and get a direct reply from the photographer.",
  },
  "/checkout/cancel": {
    title: "Checkout Cancelled — Nessebar Lens",
    description:
      "You left checkout before paying. No charge was made and your selection is still on the print page.",
    index: false,
  },
  "/checkout/success": {
    title: "Order Received — Nessebar Lens",
    description:
      "Your order reference and download link. This page belongs to your order and is not indexed.",
    index: false,
  },
};

/**
 * The same routes, in every locale whose copy is a translation.
 *
 * `PAGE_COPY` is the source, so it is the reference every other locale is held
 * against: `tests/seo-metadata.test.mts` fails when a route is added to one
 * table and not the other, when a translated title repeats another route's, or
 * when a Bulgarian string is not Bulgarian. There is deliberately no fallback
 * to English here — a `/bg` page that shipped an English `<title>` would be the
 * same lie the route guard exists to prevent, one layer down.
 *
 * The length windows in that test are English windows: they describe where
 * Google truncates, and character counts are not comparable across scripts. The
 * translated rows are checked for uniqueness and language instead of length.
 */
const TRANSLATED_PAGE_COPY: Partial<Record<Locale, Record<string, PageCopy>>> = {
  bg: {
    "/": {
      title: "Nessebar Lens — Художествена фотография от Несебър",
      description:
        "Художествени фотографии, архивни кадри и аналогова фотография от Стария Несебър. Фотографски отпечатъци и дигитални файлове.",
    },
    "/fine-art": {
      title: "Художествена фотография от Стария Несебър",
      description:
        "Художествени фотографии от Стария Несебър, отпечатани giclée върху Hahnemühle Photo Rag или предлагани като JPG файл с пълна резолюция.",
    },
    "/film": {
      title: "Аналогова фотография — 35 мм и среден формат",
      description:
        "Кадри, заснети на аналогов филм в Несебър, включително черно-бели фотографии на 35-милиметров филм.",
    },
    "/archive": {
      title: "Архив на ежедневието в Стария Несебър",
      description:
        "Улични сцени от ежедневието и документални кадри от Стария Несебър.",
    },
    "/story": {
      title: "Нашата история — Три десетилетия фотография в Несебър",
      description:
        "Историята зад колекцията на Nessebar Lens и фотографиите, заснети през десетилетията в Стария Несебър.",
    },
    "/contact": {
      title: "Контакт — отпечатъци и поръчки от Nessebar Lens",
      description:
        "Имате въпрос за фотографски отпечатък, лиценз или поръчка? Свържете се с фотографското студио Nessebar Lens.",
    },
    "/checkout/cancel": {
      title: "Плащането е отменено — Nessebar Lens",
      description:
        "Напуснахте плащането преди да платите. Не е начислена сума и изборът ви остава на страницата на отпечатъка.",
      index: false,
    },
    "/checkout/success": {
      title: "Поръчката е получена — Nessebar Lens",
      description:
        "Номерът на поръчката ви и връзката за изтегляне. Тази страница е свързана с поръчката ви и не се индексира.",
      index: false,
    },
  },
};

/**
 * A route's copy in one locale, or `undefined` when the route has none.
 *
 * The default locale reads `PAGE_COPY`; every other reads its own table. No
 * fallback on purpose: a missing translated row is a build-time failure at the
 * call site, not an English page served under a Bulgarian URL.
 */
export function pageCopy(route: string, locale: Locale): PageCopy | undefined {
  if (locale === DEFAULT_LOCALE) return PAGE_COPY[route];
  return TRANSLATED_PAGE_COPY[locale]?.[route];
}

/** The dynamic route, named the way the filesystem names it. */
export const PRINT_ROUTE = "/prints/[slug]";

/** The prefix a print's own route is built from. */
const PRINT_ROUTE_PREFIX = "/prints/";

/** The canonical path for one print — never the `[slug]` pattern itself. */
function printRoute(slug: string): string {
  // The catalog slug is the URL segment and is already the on-disk key; the
  // catalog builder validates it against PHOTO_SLUG_PATTERN, so no encoding is
  // needed here and none is applied, which keeps the canonical byte-identical
  // to what the router serves.
  return `${PRINT_ROUTE_PREFIX}${slug}`;
}

/**
 * The indexable routes, in nav order. The sitemap and the metadata test read
 * this rather than keeping their own list, so a new route cannot be indexed in
 * one place and absent from the other.
 */
export const INDEXABLE_ROUTES: readonly string[] = Object.keys(PAGE_COPY).filter(
  (route) => PAGE_COPY[route]?.index !== false,
);

/** True for a route a crawler should keep. Unknown routes are not indexed. */
export function isIndexable(route: string): boolean {
  return PAGE_COPY[route]?.index !== false && route !== PRINT_ROUTE;
}

/**
 * The `Metadata` for one of the static routes.
 *
 * Throws on an unknown route rather than returning a default: the alternative
 * is a page that exists, ships, and carries the homepage's title — the exact
 * failure this module was written for. A throw at module scope is a build-time
 * failure, which is when it can still be fixed.
 */
export function pageMetadata(
  route: string,
  locale: Locale,
  env: ConfigEnv = NODE_ENV,
): Metadata {
  const copy = pageCopy(route, locale);
  if (!copy) {
    throw new Error(
      `No PAGE_COPY entry for ${route} in ${locale}. Add the route's title and ` +
        `description there, or the page ships the root layout's metadata.`,
    );
  }
  return metadataFor(route, copy, locale, env);
}

/**
 * The `Metadata` for one of the three gallery routes, named by its category.
 *
 * Takes the slug rather than the path because a route page may not spell a
 * category href: `CATEGORY` owns those, and `tests/category-registry.test.mts`
 * fails the build when a page repeats one. Passing the slug also means the page
 * states which category it is *once* — `categoryMetadata("archive")` here and
 * `category="archive"` on the element below it — instead of twice in two
 * spellings that a rename could take apart.
 */
export function categoryMetadata(
  category: PhotoCategory,
  locale: Locale,
  env: ConfigEnv = NODE_ENV,
): Metadata {
  return pageMetadata(CATEGORY[category].href, locale, env);
}

/**
 * The `Metadata` for one print. The title names the photograph and the site —
 * a print's title is the query someone would actually make, so it leads. The
 * description is the catalog's own, which is written for a human reading the
 * page and is already unique per photo.
 *
 * The canonical is built from the photo's slug, not from `PRINT_ROUTE`. Passing
 * the filesystem pattern through here emits
 * `<link rel="canonical" href="https://…/prints/[slug]">` on every print, which
 * is a canonical pointing at a page that does not exist — the strongest possible
 * signal to deindex the four pages a visitor is most likely to arrive at.
 *
 * The length floor does not apply here and the test does not apply it: these are
 * the photographer's words, variable by design, and padding them to 60 would be
 * writing copy on the photographer's behalf.
 */
export function printMetadata(
  photo: Parameters<typeof photoForLocale>[0],
  locale: Locale,
  env: ConfigEnv = NODE_ENV,
): Metadata {
  // The catalog holds the source's words; the title a reader sees in the SERP
  // is this page's language, exactly as the page body is. `photoForLocale`
  // throws for a locale a published photo has no translation for, which the
  // catalog build already refuses — so this cannot silently fall back.
  const localized = photoForLocale(photo, locale);
  return metadataFor(
    printRoute(photo.slug),
    {
      title: `${localized.title} — ${SITE_TITLE}`,
      description: localized.description,
    },
    locale,
    env,
  );
}

/**
 * The OG/Twitter block, restated on every page.
 *
 * Not optional and not inherited: Next merges page metadata one level deep, so a
 * page that sets `openGraph.title` keeps the layout's `openGraph.images` — but a
 * page that sets `openGraph` as a whole replaces it. Returning the complete
 * object from one helper means neither shape is reachable by accident.
 */
function metadataFor(
  route: string,
  copy: PageCopy,
  locale: Locale,
  env: ConfigEnv,
): Metadata {
  // The canonical is the URL the page is actually served at, locale segment
  // and all. A canonical that pointed at the un-prefixed route would name a
  // URL that only redirects, and a crawler that believes it would index the
  // redirect rather than the page.
  const canonical = canonicalUrl(localePath(locale, route), env);
  const metadata: Metadata = {
    title: copy.title,
    description: copy.description,
    alternates: {
      canonical,
      // Every served locale's URL for this same page, plus `x-default` on the
      // default language. Built from the served list so an unpublished locale
      // is never named: an alternate pointing at a 404 is worse than none.
      languages: languageAlternates(route, env),
    },
    openGraph: {
      type: "website",
      siteName: SITE_TITLE,
      title: copy.title,
      description: copy.description,
      url: canonical,
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: SITE_TITLE }],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: [OG_IMAGE],
    },
  };
  // Stated as `noindex, nofollow` rather than omitted: the layout exports no
  // `robots` key at all, so there is no default to inherit and no second source
  // to drift from.
  if (copy.index === false) {
    metadata.robots = { index: false, follow: false };
  }
  return metadata;
}

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
import type { PhotoCategory } from "@/domain/catalog/photo-schema";
import type { Locale } from "@/domain/i18n/locale";
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
    title: "Film Photography — 35mm & 120 Grain from Old Town Nessebar",
    description:
      "Analog 35mm and 120 film negatives from Nessebar, Bulgaria — unfiltered grain, real light leaks, and Kodak and Ilford characteristics exactly as shot.",
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
  const copy = PAGE_COPY[route];
  if (!copy) {
    throw new Error(
      `No PAGE_COPY entry for ${route}. Add the route's title and description ` +
        `there, or the page ships the root layout's metadata.`,
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
  photo: { slug: string; title: string; description: string },
  locale: Locale,
  env: ConfigEnv = NODE_ENV,
): Metadata {
  return metadataFor(
    printRoute(photo.slug),
    {
      title: `${photo.title} — ${SITE_TITLE}`,
      description: photo.description,
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
    alternates: { canonical },
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
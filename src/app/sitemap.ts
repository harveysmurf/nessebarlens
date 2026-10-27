/**
 * `/sitemap.xml`, generated from the route table rather than typed out.
 *
 * A hand-written sitemap is a second list of the routes, and the failure mode is
 * the quiet one: a new page ships, nobody remembers the sitemap, and the page is
 * simply absent from it. `INDEXABLE_ROUTES` is the same set `page-metadata.ts`
 * uses to decide what a crawler should keep, and the checkout routes are absent
 * from both for the same reason — they are per-session pages carrying an order
 * reference in the URL, marked `noindex` by the same flag that excludes them
 * here. One decision, stated once.
 *
 * The photo URLs come from `PHOTOS`, so a published photo is in the sitemap the
 * moment the catalog is rebuilt. There is no third list to update.
 *
 * `lastModified` is deliberately absent. The catalog carries no trustworthy
 * modification date — the YAML has a capture year in the description text, not a
 * field — and a `lastModified` that is a build timestamp tells a crawler every
 * page changed on every deploy, which is exactly the signal that makes a crawler
 * stop trusting the field.
 *
 * `changeFrequency` is absent for the same reason: this is a site that changes
 * when a photograph is published, and any cadence stated here would be fiction.
 * `priority` is kept because it *is* an editorial judgement we can defend — the
 * home page, then the three galleries, then the story and contact, then the
 * prints.
 */

import type { MetadataRoute } from "next";
import { PHOTOS } from "@/domain/catalog/photos";
import { PUBLIC_LOCALES } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { INDEXABLE_ROUTES, canonicalUrl } from "@/infrastructure/seo/page-metadata";

/** How much each kind of page is worth to a crawler. Home first, prints last. */
function priorityFor(route: string): number {
  if (route === "/") return 1;
  if (route.startsWith("/prints/")) return 0.6;
  if (route === "/story" || route === "/contact") return 0.5;
  return 0.8;
}

export default function sitemap(): MetadataRoute.Sitemap {
  // One entry per route per served locale, and the locales come from the
  // registry rather than from a list of their own: a locale that is not
  // served has no pages to list, and a sitemap that listed them would offer a
  // crawler URLs that answer 404.
  const routes: MetadataRoute.Sitemap = PUBLIC_LOCALES.flatMap((locale) =>
    INDEXABLE_ROUTES.map((route) => ({
      url: canonicalUrl(localePath(locale, route)),
      priority: priorityFor(route),
    })),
  );

  const prints: MetadataRoute.Sitemap = PUBLIC_LOCALES.flatMap((locale) =>
    PHOTOS.map((photo) => ({
      url: canonicalUrl(localePath(locale, `/prints/${photo.slug}`)),
      // A print is a product page: the thing a search actually converts on.
      priority: 0.9,
    })),
  );

  return [...routes, ...prints];
}
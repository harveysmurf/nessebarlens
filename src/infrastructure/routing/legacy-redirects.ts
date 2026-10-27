import type { NextConfig } from "next";
import { DEFAULT_LOCALE } from "../../domain/i18n/locale";

/**
 * The legacy English URLs, and where each one goes now.
 *
 * Every public page moved under a locale segment, so the URLs that were
 * already published — and already indexed, and already in other people's
 * bookmarks — have to keep working. A permanent redirect is the whole answer:
 * a 308 says "this moved" to a crawler and to a browser, and it carries the
 * query string over, so a link to `/prints/a-photo?format=framed` lands on the
 * same print with the same selection, and a checkout link keeps its
 * `session_id`.
 *
 * The list is written out rather than derived from the route table in
 * `page-metadata.ts`, for two reasons. It is a *frozen* list: these are the
 * URLs that existed before the move, and a page added afterwards never had a
 * legacy URL to redirect from. And the route table reads the configured site
 * URL and the environment, which `next.config.ts` must not pull in: the config
 * is evaluated by a bare `node` process in `tests/no-workerd-in-build.test.mts`,
 * and a module that reads the environment there would test the wrong thing.
 *
 * `tests/i18n-routes.test.mts` holds this list against the route tree on disk,
 * so a route that exists without a legacy redirect is a test failure rather
 * than a 404 somebody finds in production.
 */

/**
 * Every route that existed before the locale segment, in the shape the router
 * knows it.
 *
 * The one parameterised route is written `/prints/:slug`, which is the router's
 * own spelling rather than the filesystem's `/prints/[slug]`: the redirect rule
 * needs a pattern Next can match, and the test that compares this list with the
 * route tree translates the one into the other.
 */
export const LEGACY_ROUTES = [
  "/",
  "/fine-art",
  "/archive",
  "/film",
  "/story",
  "/contact",
  "/checkout/success",
  "/checkout/cancel",
  "/prints/:slug",
] as const;

/** The shape of one rule in `next.config.ts`'s `redirects()`. */
export type RedirectRule = NonNullable<
  Awaited<ReturnType<NonNullable<NextConfig["redirects"]>>>
>[number];

/**
 * The redirect rules, one per legacy route.
 *
 * The destination is the default locale's path, so the site's own English
 * URLs and its legacy English URLs cannot name two different languages.
 */
export function legacyRedirects(): RedirectRule[] {
  return LEGACY_ROUTES.map((route) => ({
    source: route,
    destination: route === "/" ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${route}`,
    permanent: true,
  }));
}

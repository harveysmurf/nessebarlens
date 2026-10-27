import { splitPathParts } from "../paths/path-parts";
import { isLocale, type Locale } from "./locale";

/**
 * The one helper that turns a route into a URL.
 *
 * Every public page lives under a locale segment (`/en/fine-art`), so every
 * link the site renders has to carry one. Writing that by hand at each call
 * site is how a second locale list appears: one link forgets the prefix and
 * the visitor lands on a 404, and another spells the prefix twice. So there is
 * one function, and it is the only place that knows the shape of a localized
 * path.
 *
 * It takes the route as the site knows it — the locale-relative route the
 * domain already holds (`CATEGORY[].href`, `/prints/<slug>`, `/checkout/success`)
 * — and returns the URL for it. It also accepts a path that already carries a
 * locale, which is what makes the language switcher a single call: the switcher
 * holds the URL it is on and asks for the same URL in the other language.
 */

/**
 * A leading locale segment: two letters, then the end of the path or a slash.
 *
 * The shape is checked first and the membership second, so a path segment
 * that merely looks like a locale ("/e-store") is not mistaken for one.
 */
const LOCALE_SEGMENT = /^\/([a-z]{2})(\/.*)?$/;

/**
 * The path with its locale segment removed.
 *
 * Returns "" for the site's root, because the root is "/" before the prefix
 * and "/en" after it — there is no "/en/" to keep.
 */
function withoutLocale(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const match = LOCALE_SEGMENT.exec(normalized);
  const segment = match?.[1];
  if (segment !== undefined && isLocale(segment)) {
    const rest = match?.[2] ?? "";
    return rest === "/" ? "" : rest;
  }
  return normalized === "/" ? "" : normalized;
}

/**
 * The URL for `locale` on the route `path`.
 *
 * - The locale segment is added once: a path that already carries one is
 *   rewritten rather than prefixed twice.
 * - The route is untouched otherwise, so an encoded slug stays encoded and a
 *   query string stays byte-for-byte the caller's.
 * - The root becomes `/<locale>`, not `/<locale>/`.
 *
 * The route and its tail are split by `domain/paths/path-parts.ts`, which the
 * analytics route reads too: one place that knows where a tail begins, so the
 * two cannot disagree about it.
 */
export function localePath(locale: Locale, path: string): string {
  const { route, tail } = splitPathParts(path);
  return `/${locale}${withoutLocale(route)}${tail}`;
}

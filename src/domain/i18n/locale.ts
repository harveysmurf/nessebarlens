/**
 * The site's locales, and the one registry that owns them.
 *
 * This module is domain-safe on purpose: no React, no dictionaries, no
 * environment. Checkout, order parsing and the order email are allowed to
 * import it — they need to know which locales exist and how to spell one in a
 * BCP 47 tag, and none of that is a UI concern. The translated strings live
 * in `src/components/i18n/`.
 *
 * Two lists, deliberately, and the difference between them is the whole point:
 *
 *   - `LOCALES` — every locale the site *knows*. The dictionaries are written
 *     for all of them and the tests exercise all of them, so a slice that
 *     lands a Bulgarian translation has somewhere to put it.
 *   - `PUBLIC_LOCALES` — the locales the site *serves*. A locale in
 *     `LOCALES` but not here has no route: `/bg` is a 404, never an English
 *     page under a Bulgarian URL.
 *
 * The second list is the integration guard of the localisation epic. The page,
 * contact and checkout slices have to land before Bulgarian is exposed, or the
 * site would serve a half-English `/bg` to anyone who found the URL. Flipping
 * it is one line, and the route tree, the sitemap, the language switcher and
 * the legacy redirects all follow it.
 */

/** Every locale the site knows, in the order the switcher lists them. */
export const LOCALES = ["en", "bg"] as const;

/** A locale the site knows. */
export type Locale = (typeof LOCALES)[number];

/**
 * The locale a request without one means.
 *
 * It is also the locale the legacy English URLs redirect to, which is why the
 * redirect table is built from this constant rather than from a literal.
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * The locales that need their own copy of everything.
 *
 * The default locale's copy is the source — the top-level fields of a photo's
 * YAML, the English dictionary — so it is not a translation and is not listed
 * here. Every other known locale is: a published photo carries a translation
 * for each of them, and the catalog build fails when one is missing, so a
 * half-translated photo cannot be published.
 *
 * Being known is not being served. A locale is served only when
 * `PUBLIC_LOCALES` says so, and that list is the integration guard.
 */
export const TRANSLATED_LOCALES = LOCALES.filter(
  (locale) => locale !== DEFAULT_LOCALE,
) as readonly Exclude<Locale, typeof DEFAULT_LOCALE>[];

/**
 * The locales the site serves.
 *
 * English only, until the page, contact and checkout slices land: a Bulgarian
 * URL that served English copy would be worse than no Bulgarian URL at all —
 * a crawler would index it, a visitor would be told the site is in Bulgarian
 * and find it is not. Adding `"bg"` here is the one-line change that publishes
 * it, and nothing else has to move.
 */
export const PUBLIC_LOCALES = ["en"] as const satisfies readonly Locale[];

/**
 * The BCP 47 tag each locale is formatted with.
 *
 * English is `en-GB` rather than `en-US`: the site's copy is British English
 * ("colour", "giclée"), and a number or a date formatted with the wrong
 * region's rules is a small, permanent wrongness on every page that shows one.
 */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-GB",
  bg: "bg-BG",
};

/**
 * Each language's name in that language.
 *
 * An endonym, not a translation: a language switcher that offers "Bulgarian"
 * to a Bulgarian reader is asking them to read English to find their own
 * language. The names are the same in every dictionary, so they belong to the
 * locale rather than to the copy.
 */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  bg: "Български",
};

/**
 * The language each locale's Turnstile widget speaks.
 *
 * Plain language codes, not BCP 47 tags: the widget takes "en" and "bg", and a
 * tag it does not know ("bg-BG") leaves it on its default — an English
 * anti-spam challenge on a Bulgarian page, asking a Bulgarian reader to pass a
 * check in a language they did not choose.
 */
export const TURNSTILE_LANGUAGES: Record<Locale, string> = {
  en: "en",
  bg: "bg",
};

/**
 * Whether a string is one of the site's locales.
 *
 * A runtime guard, because the locale arrives from the URL: a segment that is
 * not in `LOCALES` is not a language, it is a 404.
 */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

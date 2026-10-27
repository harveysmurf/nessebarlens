import { LOCALES, type Locale } from "@/domain/i18n/locale";

/**
 * The site's translated strings, and the only place a translation lives.
 *
 * Static imports, on purpose: the lookup reads neither the network, the
 * filesystem, the environment, a cookie nor the browser's language, so the
 * strings a page renders are the strings that were built into it. A dictionary
 * fetched at runtime is a dictionary that can be missing, and a missing
 * dictionary that silently falls back to English is the failure this whole
 * slice exists to prevent.
 *
 * The shape is closed by the compiler: `satisfies Record<Locale, Dictionary>`
 * means a missing locale is a type error and an extra key in a dictionary
 * literal is an excess-property error, so neither can reach a build. The
 * nested key parity is asserted at runtime as well, in
 * `tests/i18n-locale.test.mts`, because the nested maps are keyed by a value
 * the compiler cannot check for equality across two objects.
 *
 * Only the language switcher is translated here. The page, catalog, contact
 * and email copy belongs to the slices that own it, and a foundation that
 * guessed at their words would put a translation nobody approved into the
 * site.
 */
export type Dictionary = {
  language: {
    /** The switcher's accessible name, in this locale. */
    label: string;
    /** The accessible name of the link to each locale, in this locale. */
    switchTo: Record<Locale, string>;
  };
  notFound: {
    /** The small line above the heading. */
    eyebrow: string;
    /** The heading. */
    title: string;
    /** The sentence under the heading. */
    body: string;
    /** The link back to the site. */
    back: string;
  };
};

const en: Dictionary = {
  language: {
    label: "Language",
    switchTo: {
      en: "Switch to English",
      bg: "Switch to Bulgarian",
    },
  },
  notFound: {
    eyebrow: "Page not found",
    title: "This page is not here",
    body: "The address you followed does not match a photograph, a gallery or the contact form. Everything the site has is one click away.",
    back: "Back to the gallery",
  },
};

const bg: Dictionary = {
  language: {
    label: "Език",
    switchTo: {
      en: "Превключи към английски",
      bg: "Превключи към български",
    },
  },
  notFound: {
    eyebrow: "Страницата не е намерена",
    title: "Тази страница я няма",
    body: "Адресът, който последвахте, не съответства на снимка, галерия или формуляр за контакт. Всичко, което има сайтът, е на едно кликване разстояние.",
    back: "Обратно към галерията",
  },
};

/** Every locale's dictionary. The `satisfies` is the missing/extra-key guard. */
export const DICTIONARIES = { en, bg } satisfies Record<Locale, Dictionary>;

/**
 * The dictionary for one locale.
 *
 * Throws for a locale the site does not have rather than returning English.
 * The locale comes from the URL, and a URL that names a language the site has
 * no words for is a 404 — not an English page wearing a Bulgarian URL.
 */
export function getDictionary(locale: Locale): Dictionary {
  const dictionary = DICTIONARIES[locale];
  if (!dictionary) {
    throw new Error(
      `No dictionary for ${locale}. Add one for every locale in LOCALES ` +
        `(${LOCALES.join(", ")}) or the page has nothing to say.`,
    );
  }
  return dictionary;
}

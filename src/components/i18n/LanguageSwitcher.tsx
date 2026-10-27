"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LOCALE_NAMES, PUBLIC_LOCALES, type Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { getDictionary } from "./dictionaries";

/**
 * The language switcher: the current language, and a link to the same page in
 * every other language the site serves.
 *
 * Real links, not a control that swaps something on click. A link is what a
 * crawler follows, what a browser can open in a new tab, and what works with
 * the keyboard and with JavaScript switched off — a switcher that hides the
 * other language behind a click handler is invisible to all three.
 *
 * The current language is a `<span>`, not a link to itself: there is no other
 * page in this language to go to, and a self-link that changes nothing is a
 * control that lies.
 *
 * The target's URL is the current URL with the locale segment replaced, so the
 * photo slug, the print selection in the query string and the checkout
 * reference all survive the switch. That mapping is `localePath`, the same
 * helper the nav uses to build its own links, so the two cannot disagree
 * about what a localized URL looks like.
 */
export function LanguageSwitcher({
  locale,
  locales = PUBLIC_LOCALES,
}: {
  /** The locale of the page being rendered. */
  locale: Locale;
  /**
   * The languages to offer. The site offers the ones it serves, which is the
   * registry's public list; a locale that is known but not served has no page
   * to link to, and a link to it would be a 404.
   */
  locales?: readonly Locale[];
}) {
  const dictionary = getDictionary(locale);
  const pathname = usePathname();
  const targets = locales.filter((candidate) => candidate !== locale);

  return (
    <nav aria-label={dictionary.language.label}>
      <ul className="flex items-center gap-3 text-[11px] tracking-widest uppercase font-medium">
        <li>
          <span aria-current="true" lang={locale} className="text-stone-900">
            {LOCALE_NAMES[locale]}
          </span>
        </li>
        {targets.map((target) => (
          <li key={target}>
            {/*
              The query string is only known to the browser, so the link that
              carries it is behind a boundary: the fallback is the same link
              without the query, and the real one replaces it once the client
              knows the URL. Without the boundary the build fails, because a
              prerendered page cannot know its own query string.
            */}
            <Suspense
              fallback={
                <LocaleLink
                  target={target}
                  pathname={pathname}
                  title={dictionary.language.switchTo[target]}
                />
              }
            >
              <LocaleLinkWithQuery
                target={target}
                pathname={pathname}
                title={dictionary.language.switchTo[target]}
              />
            </Suspense>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The link to another language, with the current query string.
 *
 * `useSearchParams` is what makes the switch preserve a print selection or a
 * checkout reference; the boundary around it is the price of asking a
 * prerendered page for something only the browser knows.
 */
function LocaleLinkWithQuery({
  target,
  pathname,
  title,
}: {
  target: Locale;
  pathname: string;
  title: string;
}) {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  return (
    <LocaleLink
      target={target}
      pathname={query ? `${pathname}?${query}` : pathname}
      title={title}
    />
  );
}

/** One link: the same page, in the other language. */
function LocaleLink({
  target,
  pathname,
  title,
}: {
  target: Locale;
  pathname: string;
  title: string;
}) {
  return (
    <Link
      href={localePath(target, pathname)}
      hrefLang={target}
      lang={target}
      title={title}
      className="text-stone-500 hover:text-stone-900 transition-colors"
    >
      {LOCALE_NAMES[target]}
    </Link>
  );
}

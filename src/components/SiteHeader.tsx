"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CATEGORY_TAGLINE } from "@/domain/catalog/categories";
import type { Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";
import { MobileNav } from "./MobileNav";
import { NAV, isActive } from "./nav";
import { containerClass } from "@/components/PageShell";
import { eyebrowClass } from "@/components/type-styles";

/**
 * The site's header: the wordmark, the desktop nav, the language switcher and
 * the mobile menu's toggle.
 *
 * The locale comes from the layout as a prop rather than from the URL, because
 * the URL is the thing being built: every link here is the route the site
 * already knows, with the locale segment put on it by `localePath`, so the
 * nav cannot point at a route that does not exist under this language.
 */
export function SiteHeader({ locale }: { locale: Locale }) {
  const pathname = usePathname();

  return (
    <header className="border-b border-gallery-200/70 bg-gallery-50/90 backdrop-blur-md sticky top-0 z-40">
      <div
        className={`${containerClass("7xl")} h-20 flex items-center justify-between gap-4`}
      >
        <Link href={localePath(locale, "/")} className="group min-w-0">
          <span className="font-serif text-2xl font-light tracking-tight block whitespace-nowrap text-gallery-900">
            NESSEBAR LENS
          </span>
          <span className={`hidden sm:block ${eyebrowClass('signature')}`}>
            Old Town Nessebar • {CATEGORY_TAGLINE}
          </span>
        </Link>

        <nav
          aria-label="Main"
          className="hidden md:flex items-center space-x-4 sm:space-x-10 text-[11px] tracking-widest uppercase font-medium"
        >
          {NAV.map((item) => {
            const href = localePath(locale, item.href);
            const active = isActive(pathname, href);
            return (
              <Link
                key={item.href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`py-2 border-b-2 transition-all ${
                  active
                    ? "border-stone-900 text-stone-900"
                    : "border-transparent text-stone-500 hover:text-stone-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/*
          The switcher is a landmark of its own, so it is labelled in the page's
          language rather than left as a second unnamed navigation. It sits
          beside the desktop nav, and the panel's own copy of it lives with the
          mobile menu, because a control the visitor cannot see is not a
          control they can use.
        */}
        <div className="hidden md:block">
          <LanguageSwitcher locale={locale} />
        </div>

        <MobileNav locale={locale} />
      </div>
    </header>
  );
}

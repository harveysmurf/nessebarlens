"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MobileNav } from "./MobileNav";
import { NAV, isActive } from "./nav";

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-gallery-200/70 bg-gallery-50/90 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-4">
        <Link href="/" className="group min-w-0">
          <span className="font-serif text-2xl font-light tracking-tight block whitespace-nowrap text-gallery-900">
            NESSEBAR LENS
          </span>
          <span className="hidden sm:block text-[9px] uppercase tracking-[0.3em] text-stone-500 font-medium">
            Old Town Nessebar • Fine Art, Archive & Film
          </span>
        </Link>

        <nav className="hidden md:flex items-center space-x-4 sm:space-x-10 text-[11px] tracking-widest uppercase font-medium">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`py-2 border-b-2 transition-all ${
                  active
                    ? "border-stone-900 text-stone-900"
                    : "border-transparent text-stone-400 hover:text-stone-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <MobileNav />
      </div>
    </header>
  );
}

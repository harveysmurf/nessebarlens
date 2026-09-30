"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/fine-art", label: "Fine Art" },
  { href: "/archive", label: "Archive" },
  { href: "/film", label: "Film Photography" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-gallery-200/70 bg-gallery-50/90 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-4">
        <Link href="/" className="group shrink-0">
          <span className="font-serif text-2xl font-light tracking-tight block text-gallery-900">
            NESSEBAR LENS
          </span>
          <span className="text-[9px] uppercase tracking-[0.3em] text-stone-500 font-medium block">
            Old Town Nessebar • Fine Art, Archive & Film
          </span>
        </Link>

        <nav className="flex items-center space-x-4 sm:space-x-10 text-[11px] tracking-widest uppercase font-medium">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
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
      </div>
    </header>
  );
}

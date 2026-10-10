"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NAV, isActive } from "./nav";

const PANEL_ID = "mobile-nav-panel";
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * The mobile navigation (#331): below `md` the inline desktop links are hidden
 * and this renders a toggle plus a full-screen panel under the header.
 *
 * Open state is keyed to the route it was opened on rather than a plain
 * boolean. A navigation changes `pathname`, so `open` flips to false without an
 * effect that calls `setState` — which `react-hooks/set-state-in-effect`
 * rejects — and Escape / resize close it through the same `close` callback.
 *
 * The panel is rendered through a portal to `document.body`. The header carries
 * `backdrop-blur`, and a filtered ancestor becomes the containing block for
 * `position: fixed` descendants, which collapsed the panel to the header's
 * 80px height when it lived inside `SiteHeader`.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;

  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const close = useCallback(() => setOpenedAt(null), []);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Resizing to `md`+ closes it: the inline desktop nav takes over.
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (query.matches) close();
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open, close]);

  // Lock body scroll while the panel is open; restore whatever was there.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const body = document.body;
    const previousRoot = root.style.overflow;
    const previousBody = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      root.style.overflow = previousRoot;
      body.style.overflow = previousBody;
    };
  }, [open]);

  // Move focus to the first link on open and back to the toggle on close.
  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    } else if (wasOpen.current) {
      toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // Keep Tab inside the toggle + panel while open.
  //
  // The panel is portaled to `document.body`, so it sits after the page content
  // in DOM order. Tabbing off the last link would normally move into that
  // content behind the overlay, and off the toggle — which lives in the header,
  // outside the portal — into it too. So the handler runs on both the toggle and
  // the panel and cycles the ring explicitly instead of wrapping only at the
  // edges.
  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab") return;
    const panelLinks = panelRef.current
      ? Array.from(
          panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
        )
      : [];
    const focusables = toggleRef.current ? [toggleRef.current, ...panelLinks] : panelLinks;
    if (focusables.length === 0) return;
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    const next =
      (current + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    event.preventDefault();
    focusables[next]?.focus();
  };

  const openMenu = () => setOpenedAt(pathname);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        onClick={open ? close : openMenu}
        onKeyDown={trapTab}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? "Close menu" : "Open menu"}
        className="md:hidden -mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-stone-900"
      >
        <span aria-hidden="true" className="relative block h-3.5 w-5">
          <span
            className={`absolute left-0 top-0 h-px w-5 bg-stone-900 transition-transform duration-300 ease-out motion-reduce:transition-none ${
              open ? "translate-y-[6px] rotate-45" : ""
            }`}
          />
          <span
            className={`absolute bottom-0 left-0 h-px w-5 bg-stone-900 transition-transform duration-300 ease-out motion-reduce:transition-none ${
              open ? "-translate-y-[6px] -rotate-45" : ""
            }`}
          />
        </span>
      </button>

      {open &&
        createPortal(
          <div
            id={PANEL_ID}
            ref={panelRef}
            onKeyDown={trapTab}
            className="fade-in motion-reduce:animate-none md:hidden fixed inset-x-0 top-20 bottom-0 z-30 bg-gallery-50/95 backdrop-blur-md"
          >
            <nav aria-label="Main" className="flex h-full flex-col px-6 pt-12 pb-10">
              <ul className="flex flex-col gap-6">
                {NAV.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={close}
                        aria-current={active ? "page" : undefined}
                        className={`font-serif text-3xl font-light transition-colors ${
                          active
                            ? "text-stone-900 underline decoration-1 underline-offset-8"
                            : "text-stone-400 hover:text-stone-900"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-auto text-[10px] uppercase tracking-[0.3em] text-stone-500">
                Old Town Nessebar • Fine Art, Archive &amp; Film
              </p>
            </nav>
          </div>,
          document.body,
        )}
    </>
  );
}

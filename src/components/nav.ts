/**
 * The site's primary navigation, shared by the desktop inline nav and the
 * mobile menu so the two can never drift (#331).
 */
export const NAV = [
  { href: "/fine-art", label: "Fine Art" },
  { href: "/archive", label: "Archive" },
  { href: "/film", label: "Film Photography" },
  { href: "/contact", label: "Contact" },
] as const;

/** A route is current when it is a link's target or a descendant of it. */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

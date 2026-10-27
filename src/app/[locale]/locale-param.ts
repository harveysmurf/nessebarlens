import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/domain/i18n/locale";

/**
 * The locale from the route segment, or a 404.
 *
 * The router already refuses a locale the site does not serve — the layout's
 * `dynamicParams: false` is what makes `/de` a 404 — so this is the second
 * line of defence rather than the mechanism. It is here because it is written
 * once instead of nine times: a page that read the segment without checking
 * it would fall back to English, and a fallback that only some pages have is
 * a page in the wrong language.
 */
export function requireLocale(value: string): Locale {
  if (!isLocale(value)) notFound();
  return value;
}

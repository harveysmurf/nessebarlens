/**
 * The JSON-LD payloads and the serializer that makes them safe to embed.
 *
 * Separate from the `<JsonLd>` component because the interesting part is
 * data, not markup: the schema.org builders are pure functions of the catalog
 * and the site configuration, so `tests/seo-schema.test.mts` can assert on them
 * without rendering anything. The component is the ten lines that emit a tag.
 *
 * The escaping is not optional. `JSON.stringify` does not escape `<`, so a
 * caption or a photo title containing `</script>` would close the tag and turn
 * the rest of the payload into markup on our own origin. Rewriting `<` as its
 * `\u003c` JSON escape is what keeps the value a string: `JSON.parse` returns
 * the original character back, and the HTML parser never sees a `<`.
 *
 * Nothing untrusted reaches these builders — the fields are catalog copy and the
 * site's own configuration — so the escape is defence in depth rather than the
 * only defence. What it does buy is that adding a caption field to a schema
 * cannot become an XSS bug without anyone revisiting this file.
 */

import { CATEGORY, categoryNames } from "../../domain/catalog/categories";
import { photoForLocale, type Photo } from "../../domain/catalog/photos";
import { DEFAULT_LOCALE, LOCALE_TAGS, type Locale } from "../../domain/i18n/locale";
import { localePath } from "../../domain/i18n/locale-path";
import { DIGITAL_PRICE_EUR } from "../../domain/pricing/pricing";
import { seoOrigin } from "./page-metadata";

/**
 * The breadcrumb's first crumb, in each language.
 *
 * "Home" is copy, not a route, so it is translated here beside the payload that
 * uses it. The category crumb comes from `CATEGORY[...].names[locale]`, the same
 * registry the nav reads, so a category rename cannot leave the markup behind.
 */
const BREADCRUMB_HOME: Record<Locale, string> = {
  en: "Home",
  bg: "Начало",
};

export type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

const SCHEMA_CONTEXT = "https://schema.org";

/**
 * Serialize for embedding in a `<script>` element.
 *
 * `<` and the two Unicode line separators, because JSON's own grammar allows
 * U+2028/U+2029 raw inside a string and a parser that follows the JS historical
 * reading of them — which includes some crawlers' HTML tokenisers — will treat a
 * line break as ending the script element.
 */
export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * `Organization` + `WebSite`, sitewide, from `layout.tsx`.
 *
 * One `@graph` rather than two script tags: a single document is one entity
 * description, and the `WebSite`'s `publisher` can then point at the
 * `Organization` by `@id` instead of repeating the name.
 */
export function sitewideJsonLd(locale: Locale = DEFAULT_LOCALE): JsonLdValue {
  const origin = seoOrigin();
  const organizationId = `${origin}/#organization`;
  // The page's own language, not the site's default: the document below it is
  // the Bulgarian document on `/bg`, and a WebSite that claimed `en` there
  // would contradict the `<html lang>` and the `hreflang` cluster.
  const siteUrl = `${origin}${localePath(locale, "/")}`;
  return {
    "@context": SCHEMA_CONTEXT,
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "Nessebar Lens",
        url: `${origin}/`,
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "Nessebar Lens",
        url: siteUrl,
        inLanguage: LOCALE_TAGS[locale],
        publisher: { "@id": organizationId },
      },
    ],
  };
}

/**
 * What one print is: a `Product` with a `BreadcrumbList` trail.
 *
 * One `Offer`, for the digital download, at the one price the catalog states.
 * The physical prints go through Prodigi, whose price depends on the size and
 * the destination — so a single EUR range for them would be invented. A
 * `Product` needs one offer to be eligible for a rich result, and the digital
 * one is always available, so it carries the offer rather than the product
 * carrying nothing.
 *
 * `AggregateRating` and `Review` are absent for the same reason: this studio has
 * published neither, and a fabricated rating is a manual action against the
 * markup, not a ranking win.
 */
export function printJsonLd(
  photo: Photo,
  image: { src: string } | null,
  locale: Locale = DEFAULT_LOCALE,
): JsonLdValue {
  const origin = seoOrigin();
  // The markup describes the page that carries it, so every URL and every word
  // in it is the page's own language. A `url` on the un-prefixed route would
  // name a redirect, and an English `name` on `/bg` would tell a crawler the
  // Bulgarian page is an English duplicate.
  const localized = photoForLocale(photo, locale);
  const url = `${origin}${localePath(locale, `/prints/${photo.slug}`)}`;
  const categoryHref = `${origin}${localePath(
    locale,
    CATEGORY[photo.category].href,
  )}`;
  const printId = `${url}/#product`;

  const product: JsonLdValue = {
    "@type": "Product",
    "@id": printId,
    name: localized.title,
    description: localized.description,
    url,
    inLanguage: LOCALE_TAGS[locale],
    image: image ? [image.src] : [],
    brand: { "@type": "Brand", name: "Nessebar Lens" },
    offers: {
      "@type": "Offer",
      price: DIGITAL_PRICE_EUR,
      priceCurrency: "EUR",
      // Digital delivery is a file the customer downloads; it is made the moment
      // an order is paid, so there is no backorder state to describe.
      availability: "https://schema.org/InStock",
      url,
    },
  };

  return {
    "@context": SCHEMA_CONTEXT,
    "@graph": [
      product,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: BREADCRUMB_HOME[locale],
            item: `${origin}${localePath(locale, "/")}`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: categoryNames(photo.category, locale).galleryTitle,
            item: categoryHref,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: localized.title,
            item: url,
          },
        ],
      },
    ],
  };
}
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

import { CATEGORY } from "../../domain/catalog/categories";
import { DEFAULT_LOCALE } from "../../domain/i18n/locale";
import type { Photo } from "../../domain/catalog/photos";
import { DIGITAL_PRICE_EUR } from "../../domain/pricing/pricing";
import { seoOrigin } from "./page-metadata";

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
export function sitewideJsonLd(): JsonLdValue {
  const origin = seoOrigin();
  const organizationId = `${origin}/#organization`;
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
        url: `${origin}/`,
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
): JsonLdValue {
  const origin = seoOrigin();
  const url = `${origin}/prints/${photo.slug}`;
  const categoryHref = `${origin}${CATEGORY[photo.category].href}`;
  const printId = `${url}/#product`;

  const product: JsonLdValue = {
    "@type": "Product",
    "@id": printId,
    name: photo.title,
    description: photo.description,
    url,
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
            name: "Home",
            item: `${origin}/`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: CATEGORY[photo.category].names[DEFAULT_LOCALE].galleryTitle,
            item: categoryHref,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: photo.title,
            item: url,
          },
        ],
      },
    ],
  };
}
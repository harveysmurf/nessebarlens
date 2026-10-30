/**
 * The JSON-LD: what the site tells a crawler it is, and what a print is for sale.
 *
 * Two things are easy to get wrong here and neither shows up in a build:
 *
 *   - **Escaping.** `JSON.stringify` does not escape `<`, so a photo title or a
 *     caption containing `</script>` closes the tag and the rest of the payload
 *     becomes markup on our own origin. The catalog is currently ours, so this is
 *     defence in depth — but the catalog is also a content directory a publisher
 *     writes into, and "we will remember to sanitize" is not a control.
 *   - **Inventing facts.** `Product` markup that claims a price range nobody
 *     sells, or an `AggregateRating` for a studio with no reviews, is a manual
 *     action risk rather than a ranking win, and Google's own guidance is that
 *     mismatched structured data loses the rich result. So exactly one `Offer`,
 *     for the one price the catalog states, and no ratings.
 *
 * The assertions are on parsed values, not on the serialized string, because
 * that is what a validator reads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DIGITAL_PRICE_EUR } from "../src/domain/pricing/pricing.ts";
import { PHOTOS } from "../src/domain/catalog/photos.ts";
import {
  printJsonLd,
  serializeJsonLd,
  sitewideJsonLd,
} from "../src/infrastructure/seo/json-ld.ts";

const SITE = "https://nessebarlens.com";

/** Parse what a crawler would parse, escaping and all. */
function embedded(value: Parameters<typeof serializeJsonLd>[0]): unknown {
  return JSON.parse(serializeJsonLd(value));
}

function withSiteUrl<T>(fn: () => T): T {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec => value as Rec;
const graphOf = (value: unknown): Rec[] => (asRecord(value)["@graph"] ?? []) as Rec[];
const byType = (value: unknown, type: string): Rec | undefined =>
  graphOf(value).find((entry) => entry["@type"] === type);

test("every document carries the schema.org context", () => {
  withSiteUrl(() => {
    for (const document of [
      sitewideJsonLd(),
      ...PHOTOS.map((photo) => printJsonLd(photo, null)),
    ]) {
      assert.equal(asRecord(document)["@context"], "https://schema.org");
    }
  });
});

test("the site describes itself as an Organization and a WebSite", () => {
  withSiteUrl(() => {
    const document = sitewideJsonLd();
    const organization = byType(document, "Organization");
    const website = byType(document, "WebSite");

    assert.ok(organization, "no Organization in the sitewide document");
    assert.ok(website, "no WebSite in the sitewide document");
    assert.equal(organization.name, "Nessebar Lens");
    assert.equal(organization.url, `${SITE}/`);
    assert.equal(website.name, "Nessebar Lens");
    assert.equal(website.url, `${SITE}/en`);
    assert.ok(
      organization["@id"],
      "the Organization needs an @id for the WebSite's publisher to reference",
    );
    assert.equal(
      asRecord(website.publisher)["@id"],
      organization["@id"],
      "publisher must point at the Organization's @id, not restate its name",
    );
  });
});

test("a print is a Product with one offer, at the price the catalog states", () => {
  withSiteUrl(() => {
    const photo = PHOTOS[0]!;
    const product = byType(printJsonLd(photo, null), "Product");

    assert.ok(product, "no Product on a print page");
    assert.equal(product.name, photo.title);
    assert.equal(product.description, photo.description);
    assert.equal(product.url, `${SITE}/en/prints/${photo.slug}`);
    assert.equal(asRecord(product.brand).name, "Nessebar Lens");

    const offer = asRecord(product.offers);
    assert.equal(offer.price, DIGITAL_PRICE_EUR);
    assert.equal(offer.priceCurrency, "EUR");
    assert.match(String(offer.availability), /InStock$/);

    // No physical price range: Prodigi quotes per size and destination, so any
    // number stated here would be one we do not sell at.
    assert.equal(offer.priceSpecification, undefined);
    assert.equal(
      product.offers,
      offer,
      "exactly one Offer, so the product is not ambiguous",
    );
  });
});

test("a print carries no rating and no review", () => {
  // The studio has published neither. Markup claiming them is a manual action.
  withSiteUrl(() => {
    for (const photo of PHOTOS) {
      const product = byType(printJsonLd(photo, null), "Product");
      assert.equal(product?.aggregateRating, undefined);
      assert.equal(product?.review, undefined);
      assert.equal(product?.ratingValue, undefined);
    }
  });
});

test("the breadcrumb is home → category → this print", () => {
  withSiteUrl(() => {
    const photo = PHOTOS.find((p) => p.category === "film") ?? PHOTOS[0]!;
    const trail = byType(printJsonLd(photo, null), "BreadcrumbList");
    assert.ok(trail, "no BreadcrumbList on a print page");

    const items = trail.itemListElement as Rec[];
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => item.position),
      [1, 2, 3],
    );
    assert.equal(items[0]?.item, `${SITE}/en`);
    assert.equal(items[2]?.item, `${SITE}/en/prints/${photo.slug}`);
    // The middle entry points at the category the print really is in, read from
    // the registry rather than re-spelled, so it tracks a category rename.
    assert.ok(
      String(items[1]?.item).startsWith(`${SITE}/en/`),
      "the category crumb must be an absolute site URL",
    );
  });
});

test("the Bulgarian print markup is Bulgarian, and names Bulgarian URLs", () => {
  withSiteUrl(() => {
    const photo = PHOTOS[0]!;
    const translation = photo.translations.bg;
    assert.ok(translation, `${photo.slug} has no Bulgarian translation to localize with`);

    const product = byType(printJsonLd(photo, null, "bg"), "Product");
    assert.ok(product, "no Product in the Bulgarian document");
    assert.equal(product.name, translation.title);
    assert.equal(product.description, translation.description);
    assert.equal(product.url, `${SITE}/bg/prints/${photo.slug}`);
    assert.equal(product.inLanguage, "bg-BG");

    const trail = byType(printJsonLd(photo, null, "bg"), "BreadcrumbList");
    const items = trail?.itemListElement as Rec[];
    assert.equal(items[0]?.name, "Начало");
    assert.equal(items[0]?.item, `${SITE}/bg`);
    assert.equal(items[2]?.item, `${SITE}/bg/prints/${photo.slug}`);

    const website = byType(sitewideJsonLd("bg"), "WebSite");
    assert.equal(website?.url, `${SITE}/bg`);
    assert.equal(website?.inLanguage, "bg-BG");
  });
});

test("the product image is the derivative the page already requests", () => {
  withSiteUrl(() => {
    const photo = PHOTOS[0]!;
    const src = "https://images.nessebarlens.com/dawn/abcdef12/2000.jpg";
    const product = byType(printJsonLd(photo, { src }), "Product");

    assert.deepEqual(product?.image, [src]);
  });
});

test("a photo with no ladder still yields a valid product", () => {
  // The ladder is off when NEXT_PUBLIC_WEB_IMAGES_BASE is unset, and the page
  // renders the alt text instead. `image: []` is what schema.org accepts for
  // "no image"; an undefined key would fail the validator instead.
  withSiteUrl(() => {
    const product = byType(printJsonLd(PHOTOS[0]!, null), "Product");
    assert.deepEqual(product?.image, []);
  });
});

test("a '<' in catalog copy cannot close the script element", () => {
  const hostile = "<script>alert(1)</script>";
  const serialized = serializeJsonLd({ name: hostile });

  assert.ok(!serialized.includes("<"), "a raw < survived serialization");
  assert.ok(serialized.includes("\\u003c"), "the escape is the documented one");
  assert.equal(
    asRecord(embedded({ name: hostile })).name,
    hostile,
    "JSON.parse must return the original characters",
  );
});

test("line separators are escaped too", () => {
  // Raw U+2028/U+2029 are legal in a JSON string and end the element for some
  // parsers that follow the pre-ES2019 JavaScript reading of them.
  const serialized = serializeJsonLd({ caption: "a b c" });
  assert.ok(!serialized.includes(" "));
  assert.ok(!serialized.includes(" "));
  assert.equal(asRecord(embedded({ caption: "a b c" })).caption, "a b c");
});

test("what the page renders parses back as JSON", () => {
  // The end-to-end claim: the exact string that goes into the <script> element
  // is valid JSON, so a schema validator reads it rather than reporting a
  // syntax error.
  withSiteUrl(() => {
    for (const document of [
      sitewideJsonLd(),
      ...PHOTOS.map((photo) =>
        printJsonLd(photo, { src: "https://example.com/a.jpg" }),
      ),
    ]) {
      assert.doesNotThrow(() => JSON.parse(serializeJsonLd(document)));
    }
  });
});

test("a builder reads the configured origin, not a hardcoded one", () => {
  withSiteUrl(() => {
    const website = byType(sitewideJsonLd(), "WebSite");
    assert.equal(website?.url, `${SITE}/en`);
  });
  process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.com";
  try {
    const website = byType(sitewideJsonLd(), "WebSite");
    assert.equal(
      website?.url,
      "https://staging.example.com/en",
      "a preview deployment must describe itself, not the production origin",
    );
  } finally {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  }
});
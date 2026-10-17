/**
 * `/sitemap.xml`, generated rather than typed out.
 *
 * `/sitemap.xml` was a 404 before #438, so nothing told a crawler what the site
 * contained. The risk in adding one is not that it is wrong, it is that it goes
 * stale: a hand-written list and a new page are two independent things, and the
 * list is the one nobody remembers. So the properties held here are about the
 * relationship to the routes and the catalog, not about a fixed snapshot.
 *
 * `lastModified` gets its own test because it is the field most likely to be
 * added "to be helpful" — and a build timestamp tells a crawler every page
 * changed on every deploy, which is what makes the field get ignored.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PHOTOS } from "../src/domain/catalog/photos.ts";
import { INDEXABLE_ROUTES } from "../src/infrastructure/seo/page-metadata.ts";
import robots from "../src/app/robots.ts";
import sitemap from "../src/app/sitemap.ts";

const root = path.join(import.meta.dirname, "..");
const SITE = "https://nessebarlens.com";

/** sitemap() reads process.env through the same config reader as everything else. */
function withSiteUrl(): MetadataRouteSitemap {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  try {
    return sitemap() as MetadataRouteSitemap;
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

/** The MetadataRoute.Sitemap element shape, locally so this file needs no import. */
type MetadataRouteSitemap = {
  url: string;
  lastModified?: string | Date;
  changeFrequency?: string;
  priority?: number;
}[];

test("every public route and every photograph is listed", () => {
  const urls = withSiteUrl().map((entry) => entry.url);

  for (const route of INDEXABLE_ROUTES) {
    const expected = route === "/" ? `${SITE}/` : `${SITE}${route}`;
    assert.ok(urls.includes(expected), `sitemap is missing ${expected}`);
  }

  for (const photo of PHOTOS) {
    assert.ok(
      urls.includes(`${SITE}/prints/${photo.slug}`),
      `sitemap is missing the print /prints/${photo.slug}`,
    );
  }
});

test("the checkout pages are absent, because they carry a session id", () => {
  const urls = withSiteUrl().map((entry) => entry.url);
  for (const url of urls) {
    assert.doesNotMatch(url, /\/checkout\//, `${url} must not be in the sitemap`);
    assert.doesNotMatch(url, /\/api\//, `${url} must not be in the sitemap`);
  }
});

test("the home page is listed once, with its trailing slash, and nothing else is", () => {
  const urls = withSiteUrl().map((entry) => entry.url);
  const homes = urls.filter((url) => url === `${SITE}/` || url === SITE);
  assert.deepEqual(homes, [`${SITE}/`]);

  // No duplicates: a repeated URL is read as a soft 404 signal by some crawlers.
  assert.equal(new Set(urls).size, urls.length);
});

test("every URL is absolute and under the configured origin", () => {
  for (const { url } of withSiteUrl()) {
    assert.ok(
      url.startsWith(`${SITE}/`),
      `${url} is not absolute under ${SITE}; a relative entry is resolved ` +
        `against whatever origin the crawler fetched it from`,
    );
    assert.doesNotMatch(url, /\s/, `${url} contains whitespace`);
  }
});

test("no invented lastModified or changeFrequency", () => {
  // The catalog carries no trustworthy modification date, and this site changes
  // when a photograph is published. A `lastModified` of `new Date()` would mark
  // every URL as modified on every deploy, which is how the field gets ignored.
  for (const entry of withSiteUrl()) {
    assert.equal(
      entry.lastModified,
      undefined,
      `${entry.url} claims a lastModified the catalog cannot support`,
    );
    assert.equal(
      entry.changeFrequency,
      undefined,
      `${entry.url} claims a change frequency that is a guess`,
    );
  }
});

test("priority ranks the home page first and the prints above the prose pages", () => {
  const byUrl = new Map(withSiteUrl().map((entry) => [entry.url, entry.priority]));

  assert.equal(byUrl.get(`${SITE}/`), 1);
  // A print is a product page — the thing a search converts on.
  for (const photo of PHOTOS) {
    assert.equal(byUrl.get(`${SITE}/prints/${photo.slug}`), 0.9);
  }
  assert.ok((byUrl.get(`${SITE}/story`) ?? 0) < 0.9);
  assert.ok((byUrl.get(`${SITE}/contact`) ?? 0) < 0.9);
});

test("the sitemap follows the route table, not a copy of it", () => {
  // If someone types a URL into sitemap.ts instead of adding a route, the two
  // lists drift silently. Comparing the counts catches that in one place.
  const expected = INDEXABLE_ROUTES.length + PHOTOS.length;
  assert.equal(
    withSiteUrl().length,
    expected,
    "the sitemap has entries the route table and the catalog do not account for",
  );
});
test("robots.txt allows the site and names the sitemap", () => {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  try {
    const document = robots();
    assert.equal(document.sitemap, `${SITE}/sitemap.xml`);
    // No Disallow on purpose: the two routes that must not be crawled say so
    // with their own `robots: { index: false }`, and a second copy of that
    // decision here is a second thing to keep in step.
    const rules = Array.isArray(document.rules) ? document.rules : [document.rules];
    for (const rule of rules) {
      assert.equal(rule.userAgent, "*");
      assert.equal(rule.allow, "/");
      assert.equal(rule.disallow, undefined, "the noindex routes are not repeated here");
    }
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
});

test("the sitemap and robots.txt agree on the origin", () => {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.com";
  try {
    // A robots.txt pointing at a production sitemap on a preview is how a
    // staging deployment gets crawled as the real site.
    assert.equal(robots().sitemap, "https://staging.example.com/sitemap.xml");
    for (const { url } of sitemap() as MetadataRouteSitemap) {
      assert.ok(url.startsWith("https://staging.example.com/"), url);
    }
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
});

test("llms.txt lists the public pages and points at the sitemap", () => {
  const llms = fs.readFileSync(path.join(root, "public", "llms.txt"), "utf8");

  assert.match(llms, /sitemap\.xml/, "llms.txt must point at the machine-readable index");
  for (const route of INDEXABLE_ROUTES) {
    if (route === "/") continue;
    assert.ok(
      llms.includes(`https://nessebarlens.com${route}`),
      `llms.txt does not mention ${route}`,
    );
  }
  // The per-photo pages change with every publish, so llms.txt points at the
  // sitemap instead of carrying a second list that goes stale.
  assert.doesNotMatch(llms, /\/prints\/[a-z0-9-]{20,}/, "llms.txt must not duplicate the print list");
});

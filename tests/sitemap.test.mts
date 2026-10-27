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
import { DEFAULT_LOCALE, PUBLIC_LOCALES } from "../src/domain/i18n/locale.ts";
import { localePath } from "../src/domain/i18n/locale-path.ts";
import { INDEXABLE_ROUTES, canonicalUrl } from "../src/infrastructure/seo/page-metadata.ts";
import robots from "../src/app/robots.ts";
import sitemap from "../src/app/sitemap.ts";
import { GET as llmsRoute } from "../src/app/llms.txt/route.ts";

const root = path.join(import.meta.dirname, "..");
const SITE = "https://nessebarlens.com";

/** The body llms.txt serves, with the site URL pinned the way the site pins it. */
async function llmsText(siteUrl: string = SITE): Promise<string> {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = siteUrl;
  try {
    return await llmsRoute().text();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

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
    const expected = `${SITE}${localePath(DEFAULT_LOCALE, route)}`;
    assert.ok(urls.includes(expected), `sitemap is missing ${expected}`);
  }

  for (const photo of PHOTOS) {
    const expected = `${SITE}${localePath(DEFAULT_LOCALE, `/prints/${photo.slug}`)}`;
    assert.ok(
      urls.includes(expected),
      `sitemap is missing the print /prints/${photo.slug}`,
    );
  }
});

test("the sitemap and llms.txt build their URLs through the canonical helper", async () => {
  // Both surfaces used to write the rule themselves -- origin + route, with the
  // root's trailing slash handled by hand -- while `canonicalUrl()` owned it.
  // The copies were weaker: they did not normalise a missing leading slash, so
  // a route added without one would have produced a URL on the origin's root.
  // Read the owner and compare, so a second spelling cannot come back.
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  try {
    const urls = new Set((sitemap() as MetadataRouteSitemap).map((e) => e.url));
    for (const route of INDEXABLE_ROUTES) {
      assert.ok(
        urls.has(canonicalUrl(localePath(DEFAULT_LOCALE, route))),
        `sitemap is missing the canonical URL for ${route}`,
      );
    }
    for (const photo of PHOTOS) {
      assert.ok(
        urls.has(canonicalUrl(localePath(DEFAULT_LOCALE, `/prints/${photo.slug}`))),
        `sitemap is missing the canonical URL for /prints/${photo.slug}`,
      );
    }

    const body = await llmsRoute().text();
    for (const route of INDEXABLE_ROUTES) {
      assert.ok(
        body.includes(canonicalUrl(localePath(DEFAULT_LOCALE, route))),
        `llms.txt does not mention the canonical URL for ${route}`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
});

test("the checkout pages are absent, because they carry a session id", () => {
  const urls = withSiteUrl().map((entry) => entry.url);
  for (const url of urls) {
    assert.doesNotMatch(url, /\/checkout\//, `${url} must not be in the sitemap`);
    assert.doesNotMatch(url, /\/api\//, `${url} must not be in the sitemap`);
  }
});

test("the home page is listed once, under its locale, and nothing else is", () => {
  const urls = withSiteUrl().map((entry) => entry.url);
  // The home page is the locale root now, and it is listed once. The old,
  // un-prefixed root is a permanent redirect, and a sitemap entry for it would
  // offer a crawler a URL that only redirects.
  const home = `${SITE}${localePath(DEFAULT_LOCALE, "/")}`;
  assert.deepEqual(
    urls.filter((url) => url === home),
    [home],
    "the home page is listed once, under its locale",
  );
  assert.ok(
    !urls.includes(`${SITE}/`),
    "the un-prefixed root is a redirect, not a page, and must not be listed",
  );

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

  assert.equal(byUrl.get(`${SITE}${localePath(DEFAULT_LOCALE, "/")}`), 1);
  // A print is a product page — the thing a search converts on.
  for (const photo of PHOTOS) {
    assert.equal(
      byUrl.get(`${SITE}${localePath(DEFAULT_LOCALE, `/prints/${photo.slug}`)}`),
      0.9,
    );
  }
  assert.ok(
    (byUrl.get(`${SITE}${localePath(DEFAULT_LOCALE, "/story")}`) ?? 0) < 0.9,
  );
  assert.ok(
    (byUrl.get(`${SITE}${localePath(DEFAULT_LOCALE, "/contact")}`) ?? 0) < 0.9,
  );
});

test("the sitemap follows the route table, not a copy of it", () => {
  // If someone types a URL into sitemap.ts instead of adding a route, the two
  // lists drift silently. Comparing the counts catches that in one place.
  const expected =
    (INDEXABLE_ROUTES.length + PHOTOS.length) * PUBLIC_LOCALES.length;
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

test("llms.txt lists the public pages and points at the sitemap", async () => {
  const body = await llmsText();

  assert.match(body, /sitemap\.xml/, "llms.txt must point at the machine-readable index");
  for (const route of INDEXABLE_ROUTES) {
    if (route === "/") continue;
    assert.ok(
      body.includes(
        `https://nessebarlens.com${localePath(DEFAULT_LOCALE, route)}`,
      ),
      `llms.txt does not mention ${route}`,
    );
  }
  // The per-photo pages change with every publish, so llms.txt points at the
  // sitemap instead of carrying a second list that goes stale.
  assert.doesNotMatch(body, /\/prints\/[a-z0-9-]{20,}/, "llms.txt must not duplicate the print list");
});

test("llms.txt carries the configured origin, so a staging build ships staging URLs", async () => {
  const body = await llmsText("https://staging.example.com");
  // Same reason the sitemap and robots assertions above exist: a preview that
  // advertises the production origin tells a crawler the preview is the site.
  assert.ok(body.includes("https://staging.example.com/"), body.slice(0, 200));
  assert.doesNotMatch(
    body,
    /https:\/\/nessebarlens\.com/,
    "a staging build of llms.txt is advertising the production origin",
  );
});

test("no file in public/ hardcodes a site origin", () => {
  // `public/` is copied into `.open-next` verbatim — nothing in the build
  // rewrites it. A site origin written into one of those files therefore ships
  // to *both* environments, and the only thing that notices is
  // `scripts/assert-artifact-origin.sh`, after a full build, in CI.
  //
  // llms.txt did exactly this (#438): seven references to the production origin
  // in a file the staging deploy refused. A static file in `public/` may describe
  // the site's *content*; it may not name the site's address.
  const dir = path.join(root, "public");
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (name.endsWith(".jpg") || name.endsWith(".png") || name.endsWith(".ico")) continue;

    const text = fs.readFileSync(full, "utf8");
    if (/https:\/\/(staging\.)?nessebarlens\.com/.test(text)) offenders.push(name);
  }

  assert.deepEqual(
    offenders,
    [],
    "these files in public/ name a site origin and will ship it to both environments. " +
      "Build the URL from configuredSiteUrl() in a route instead.",
  );
});

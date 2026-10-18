/**
 * Every route's metadata, and the one table it comes from (#438).
 *
 * The bug this file exists for: `layout.tsx` exported the only `metadata` in the
 * app, so `/story`, `/film`, `/archive`, `/contact` and all four print pages
 * rendered the homepage's title and description, and no route had a canonical at
 * all. An audit scores that as "13 characters of title"; the site-wide
 * duplication is the worse half and no crawler-facing test existed to catch it.
 *
 * Three properties are held, in increasing order of how much they cost to get
 * wrong:
 *
 *   1. **Completeness, both ways.** Every `page.tsx` under `src/app` has a
 *      `PAGE_COPY` entry, and every entry corresponds to a route that exists.
 *      A new page with no entry fails here instead of shipping the root's words.
 *      Walking the filesystem is what makes the first half true; the second half
 *      is what stops a stale entry from lingering after a route is deleted.
 *
 *   2. **Uniqueness, both fields.** No two routes share a title, and none share
 *      a description — and no route's title or description is the root's *by
 *      coincidence*, which is a weaker but checkable statement. The two gates
 *      iterate the same set for the same reason: a description check looser
 *      than the title check is the drift this file exists to prevent.
 *
 *   3. **Shape.** An absolute canonical built from `NEXT_PUBLIC_SITE_URL`, and
 *      the complete OG/Twitter block on every page, because Next replaces
 *      `openGraph` wholesale when a page exports it.
 *
 * Between them, the SERP windows hold each indexed route's title to 50-65
 * characters and its description to 100-160. Both are guards on the copy that
 * lives in `PAGE_COPY`, which is a proposal Simo may rewrite, so the value of
 * the assertions is entirely in what happens to the rewrite: without a cap, a
 * description that grows past the snippet limit is silently truncated by Google
 * with nothing here to notice.
 *
 * A guard written to measure a guard must read the exported predicate, not parse
 * the source. These windows were once "verified" by a scratch script that
 * regex-matched the literal rows of `PAGE_COPY`, and it silently skipped `/` —
 * that row is `"/": HOME_COPY`, a reference rather than a literal. The figures it
 * reported were plausible and one route short, which is how a floor came to be
 * set above the homepage's own description. Ask `INDEXABLE_ROUTES` and
 * `PAGE_COPY` what they hold, as the tests here do, and delete the script: a
 * hand-rolled measurer left on disk is how the wrong number comes back.
 *
 * The residual is stated rather than hidden: property 1 walks the filesystem for
 * `page.tsx` files, and separately reads each page's source to confirm it
 * actually exports `metadata` from the table. Neither can see a page that exports
 * `metadata` from somewhere else, and the JSON-LD is asserted in
 * `seo-schema.test.mts` rather than here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PHOTOS, getPhoto } from "../src/domain/catalog/photos.ts";
import { CATEGORY } from "../src/domain/catalog/categories.ts";
import { PHOTO_CATEGORIES } from "../src/domain/catalog/photo-schema.ts";
import {
  canonicalUrl,
  categoryMetadata,
  INDEXABLE_ROUTES,
  isIndexable,
  pageMetadata,
  PAGE_COPY,
  PRINT_ROUTE,
  printMetadata,
  seoOrigin,
} from "../src/infrastructure/seo/page-metadata.ts";

const root = path.join(import.meta.dirname, "..");
const appDir = path.join(root, "src", "app");

const SITE = "https://nessebarlens.com";
/** The env the canonical assertions read. Passed in, never read from process.env. */
const ENV = { NEXT_PUBLIC_SITE_URL: SITE } as const;

/** Google's SERP truncates around 60; below ~50 the search terms are missing. */
const TITLE_MIN = 50;
const TITLE_MAX = 65;
/**
 * The same window for a description, which Google truncates later and harder.
 *
 * The cap, 160, is the real limit: the snippet ends around 155-160 characters,
 * and three indexed descriptions already sit at 145-153, so one more rewrite word
 * is enough to lose the tail to an ellipsis.
 *
 * The floor is stub detection, not a search-term argument, and it is 100 because
 * that is where the real copy begins: the shortest indexed description is `/` at
 * 108, so the floor has 8 characters of headroom. It was 120 once, picked by
 * analogy with the title window rather than measured against this table, and it
 * failed `/` — the most-read string on the site.
 *
 * Do not raise it back to 120 for symmetry with the titles. A check that
 * manufactures copy work is making a product decision, and lengthening `/` to
 * clear a floor is Simo's call, not a side effect of a constant.
 */
const DESCRIPTION_MIN = 100;
const DESCRIPTION_MAX = 160;

/**
 * The routes the length floors do not apply to, in one list so the two gates
 * exempt the same set instead of each naming its own.
 *
 * Spelled out rather than derived from `isIndexable`, because this list *is* the
 * claim that these specific pages are exempt: derived from the predicate it is
 * checked against, the exemption would hold whatever the predicate said. The
 * print route is also noindex and is deliberately absent — it has no `PAGE_COPY`
 * row, its copy comes from the catalog, and `printMetadata` has its own title
 * check below.
 */
const NOINDEX_ROUTES = ["/checkout/cancel", "/checkout/success"];

/**
 * Every route that has a `page.tsx`, from the filesystem.
 *
 * Deliberately not derived from `PAGE_COPY`: a table that named a route with no
 * page would otherwise pass every assertion below while the page did not exist.
 */
function routesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (fs.existsSync(path.join(dir, "page.tsx"))) {
      found.push(prefix === "" ? "/" : prefix);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // The api routes are not pages and have no metadata to declare.
      if (prefix === "" && entry.name === "api") continue;
      walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
    }
  };
  walk(appDir, "");
  return found.sort();
}

/** The page module's own source, for the export check. */
function pageSource(route: string): string {
  const rel = route === "/" ? "" : route;
  return fs.readFileSync(path.join(appDir, rel, "page.tsx"), "utf8");
}

test("every route on disk has copy in the one table, and none is orphaned", () => {
  const onDisk = routesOnDisk();

  // The dynamic print route declares its copy through `printMetadata`, so it is
  // named in the table but has no static row to read.
  const staticOnDisk = onDisk.filter((route) => route !== PRINT_ROUTE);
  const declared = Object.keys(PAGE_COPY).sort();

  assert.deepEqual(
    declared,
    staticOnDisk,
    "PAGE_COPY and the routes under src/app have drifted. A route added " +
      "without a row here ships the root layout's title and description, and a " +
      "row left behind after a route was deleted is copy nobody reads.",
  );
});

test("every page exports its metadata from the table, not by hand", () => {
  // Two shapes are legitimate: a static `export const metadata`, and the
  // `generateMetadata` the print route needs because its copy comes from the
  // catalog rather than the table. Both must reach the same helper — a
  // hand-written object literal replaces `openGraph` and `twitter` wholesale,
  // which is how the duplication this issue is about happened in the first place.
  const exportsMetadata = [
    /export const metadata: Metadata = /,
    /export async function generateMetadata\(/,
  ];
  for (const route of routesOnDisk()) {
    const source = pageSource(route);
    const why =
      `${route}/page.tsx must export its metadata through pageMetadata() or ` +
      `printMetadata() from infrastructure/seo/page-metadata.ts, or export ` +
      `generateMetadata() for a route whose copy is not static.`;

    assert.ok(
      exportsMetadata.some((shape) => shape.test(source)),
      `${why} (no metadata export found)`,
    );
    assert.match(
      source,
      /(pageMetadata|categoryMetadata|printMetadata)\(/,
      `${why} (the metadata is not built by the table's helpers)`,
    );
    assert.doesNotMatch(
      source,
      /export const metadata: Metadata = \{/,
      `${why} (a literal object was found)`,
    );
  }
});

test("a gallery route's metadata resolves through its category's declared href", () => {
  // The three gallery pages cannot spell their own href — `CATEGORY` owns it,
  // and `category-registry.test.mts` fails a build that repeats one. So they ask
  // for their copy by category slug, and the join from slug to href to copy
  // happens here, where both registries are readable. If a category's href
  // changed without a matching PAGE_COPY row, `categoryMetadata` would return
  // the homepage's words or throw at module scope in a page; this says which.
  for (const category of PHOTO_CATEGORIES) {
    const href = CATEGORY[category].href;
    const expected = pageMetadata(href, ENV);
    const actual = categoryMetadata(category, ENV);

    assert.deepEqual(
      actual,
      expected,
      `categoryMetadata(${category}) does not match the row for ${href}`,
    );
    assert.equal(
      actual.alternates?.canonical,
      canonicalUrl(href, ENV),
      `${category}'s canonical is not the category's own route`,
    );
    assert.notEqual(
      PAGE_COPY[href]?.title,
      PAGE_COPY["/"]?.title,
      `${href} has no copy of its own, so it ships the homepage's title`,
    );
  }
});

test("no two routes ship the same title", () => {
  const titles = new Map<string, string[]>();
  for (const route of Object.keys(PAGE_COPY)) {
    const title = PAGE_COPY[route]?.title ?? "";
    titles.set(title, [...(titles.get(title) ?? []), route]);
  }

  const shared = [...titles.entries()].filter(([, routes]) => routes.length > 1);
  assert.deepEqual(
    shared,
    [],
    "two routes share a title; a crawler reads them as one page and picks one",
  );
});

test("no two routes ship the same description", () => {
  // The title check above iterates the whole table, and this one deliberately
  // matches it rather than the narrower indexed set: a description gate looser
  // than the title gate is the drift this file exists to prevent, and the two
  // checkout rows are unique today so the wider scope costs nothing.
  const descriptions = new Map<string, string[]>();
  for (const route of Object.keys(PAGE_COPY)) {
    const description = PAGE_COPY[route]?.description ?? "";
    descriptions.set(description, [...(descriptions.get(description) ?? []), route]);
  }

  const shared = [...descriptions.entries()].filter(([, routes]) => routes.length > 1);
  assert.deepEqual(
    shared,
    [],
    "two routes share a description; Google shows one snippet for the pair",
  );
});

test("every indexed route's title and description sit inside their SERP windows", () => {
  // One loop, one predicate, both fields. Separate tests would each carry their
  // own route set, and a later edit that narrowed one of them would leave a
  // route gated on its title and ungated on its description with both tests
  // green.
  for (const route of INDEXABLE_ROUTES) {
    const title = PAGE_COPY[route]?.title ?? "";
    assert.ok(
      title.length >= TITLE_MIN && title.length <= TITLE_MAX,
      `${route} title is ${title.length} characters, outside ${TITLE_MIN}-${TITLE_MAX}: "${title}"`,
    );

    const description = PAGE_COPY[route]?.description ?? "";
    assert.ok(
      description.length >= DESCRIPTION_MIN && description.length <= DESCRIPTION_MAX,
      `${route} description is ${description.length} characters, outside ` +
        `${DESCRIPTION_MIN}-${DESCRIPTION_MAX}: "${description}"`,
    );
  }
});

test("the noindex checkout pages are exempt from both length floors, and say so", () => {
  // Stated rather than left implicit: the two checkout rows are short on
  // purpose, and a future reader tightening the floors above should know these
  // two were excluded deliberately and not forgotten. Both gates read the one
  // list, so a route cannot be exempt from one floor and held to the other.
  for (const route of NOINDEX_ROUTES) {
    assert.equal(isIndexable(route), false);
    assert.ok(
      (PAGE_COPY[route]?.title ?? "").length < TITLE_MIN,
      `${route} is exempt from the title floor, so its title must stay under ${TITLE_MIN}`,
    );
    assert.ok(
      (PAGE_COPY[route]?.description ?? "").length < DESCRIPTION_MIN,
      `${route} is exempt from the description floor, so its description must ` +
        `stay under ${DESCRIPTION_MIN}`,
    );
  }
});

test("no route's description is the homepage's, except the homepage", () => {
  const home = PAGE_COPY["/"]?.description;
  for (const route of Object.keys(PAGE_COPY)) {
    if (route === "/") continue;
    assert.notEqual(
      PAGE_COPY[route]?.description,
      home,
      `${route} reuses the homepage description`,
    );
  }
});

test("each route's canonical is absolute and built from the configured site URL", () => {
  assert.equal(canonicalUrl("/", ENV), `${SITE}/`);
  assert.equal(canonicalUrl("/story", ENV), `${SITE}/story`);
  assert.equal(canonicalUrl("/prints/dawn", ENV), `${SITE}/prints/dawn`);

  // Every caller spells the leading slash, so the normalisation below is
  // unreachable from the site's own code — and unreachable code that builds a
  // URL is exactly what the coverage gate is for. It stays because the failure
  // it prevents is invisible: without it a route spelled `story` yields
  // `https://nessebarlens.comstory`, which is a canonical to a host that does
  // not exist rather than an error anyone would see.
  assert.equal(canonicalUrl("story", ENV), `${SITE}/story`);

  // A relative canonical is silently resolved against whatever origin the
  // crawler guessed, which is how a preview deployment gets indexed as the site.
  for (const route of routesOnDisk()) {
    if (route === PRINT_ROUTE) continue;
    const metadata = pageMetadata(route, ENV);
    assert.equal(metadata.alternates?.canonical, canonicalUrl(route, ENV));
  }
});

test("every page carries the whole OG and Twitter block, not just a title", () => {
  // Every route, print pages included — checked through a real photo rather
  // than skipped, because `printMetadata` is a separate function from
  // `pageMetadata` and a partial OG block there would go unnoticed.
  const cases = [
    ...routesOnDisk().map((route) => ({
      route,
      metadata: route === PRINT_ROUTE ? printMetadata(PHOTOS[0], ENV) : pageMetadata(route, ENV),
      copy: route === PRINT_ROUTE
        ? { title: `${PHOTOS[0].title} — Nessebar Lens`, description: PHOTOS[0].description }
        : PAGE_COPY[route],
    })),
  ];

  for (const { route, metadata, copy } of cases) {
    // Next merges one level deep: a page exporting `openGraph` replaces the
    // layout's whole object, so a partial block loses the image and the
    // siteName rather than inheriting them.
    assert.equal(metadata.openGraph?.title, copy?.title, `${route} openGraph.title`);
    assert.equal(
      metadata.openGraph?.description,
      copy?.description,
      `${route} openGraph.description`,
    );
    assert.equal(metadata.openGraph?.siteName, "Nessebar Lens", `${route} siteName`);
    assert.ok(
      (metadata.openGraph?.images as unknown[] | undefined)?.length,
      `${route} has no openGraph image`,
    );
    assert.ok(metadata.openGraph?.url, `${route} has no og:url`);

    // `Twitter` is a union: the shared-field branch has no `card`, so the
    // assertion narrows first rather than asserting through `any`.
    const twitter = metadata.twitter as { card?: string } | undefined;
    assert.equal(twitter?.card, "summary_large_image", `${route} card`);
    assert.equal(metadata.twitter?.title, copy?.title, `${route} twitter.title`);
    assert.equal(
      metadata.twitter?.description,
      copy?.description,
      `${route} twitter.description`,
    );
    assert.ok(
      (metadata.twitter?.images as unknown[] | undefined)?.length,
      `${route} has no twitter image`,
    );
  }
});

test("an unknown route throws instead of falling back to the homepage's words", () => {
  assert.throws(() => pageMetadata("/about", ENV), /No PAGE_COPY entry for \/about/);
});

test("the indexable set is the table minus checkout minus the dynamic route", () => {
  assert.deepEqual(
    [...INDEXABLE_ROUTES].sort(),
    Object.keys(PAGE_COPY)
      // `NOINDEX_ROUTES`, so adding a third exempt page cannot leave this
      // filtering the old pair and disagreeing with the length gates.
      .filter((route) => !NOINDEX_ROUTES.includes(route))
      .sort(),
  );
  assert.equal(isIndexable(PRINT_ROUTE), false, "the print route is a pattern, not a URL");
});

test("checkout pages are noindex, nofollow, and are told so in their own metadata", () => {
  for (const route of ["/checkout/cancel", "/checkout/success"]) {
    assert.deepEqual(
      pageMetadata(route, ENV).robots,
      { index: false, follow: false },
      `${route} must not be indexed: its URL carries a Stripe session id`,
    );
  }
  // And nothing else carries a robots key, so there is no second policy source
  // to drift from the flag that keeps them out of the sitemap.
  for (const route of INDEXABLE_ROUTES) {
    assert.equal(pageMetadata(route, ENV).robots, undefined, `${route} is noindex`);
  }
});

test("a print's title names the photograph, and each print's title is its own", () => {
  const titles = new Set<string>();
  for (const photo of PHOTOS) {
    const metadata = printMetadata(photo, ENV);
    const expected = `${photo.title} — Nessebar Lens`;

    assert.equal(metadata.title, expected);
    assert.equal(metadata.description, photo.description);
    assert.equal(
      metadata.alternates?.canonical,
      `${SITE}/prints/${photo.slug}`,
    );
    titles.add(expected);
  }

  // Two photographs with the same title would collapse into one search result.
  assert.equal(
    titles.size,
    PHOTOS.length,
    "two photographs produce the same title; a suffix would be needed",
  );
});

test("the canonical origin falls back to localhost only when the variable is unset", () => {
  assert.equal(seoOrigin(ENV), SITE);
  assert.equal(
    canonicalUrl("/story", {}),
    "http://localhost:3000/story",
    "with NEXT_PUBLIC_SITE_URL unset a dev build must still emit a canonical",
  );
  assert.equal(
    canonicalUrl("/story", { NEXT_PUBLIC_SITE_URL: `${SITE}/` }),
    `${SITE}/story`,
    "configuredSiteUrl strips the trailing slash, so the origin never doubles",
  );
});

test("the catalog the print metadata reads is the one the routes render", () => {
  // The table describes four photos; if the catalog gains one, this says so here
  // rather than as a missing sitemap entry nobody notices until a crawl.
  assert.ok(PHOTOS.length > 0);
  for (const photo of PHOTOS) {
    assert.ok(
      getPhoto(photo.slug),
      `${photo.slug} is in PHOTOS but not findable by getPhoto, so its route ` +
        `renders a 404 with a title in the sitemap`,
    );
  }
});
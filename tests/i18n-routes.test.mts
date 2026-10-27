/**
 * The route tree, the legacy redirects and the language switcher's mapping.
 *
 * The public pages moved under a locale segment, so this slice has to hold
 * three things at once:
 *
 *   1. **The old URLs still work.** Every URL that was published before the
 *      move permanently redirects to its `/en` equivalent, and the query
 *      string survives the hop — the print selection in `?format=framed` and
 *      the `session_id` on a checkout return are not decoration, they are the
 *      difference between the page a visitor asked for and a different one.
 *
 *   2. **The URLs that must not move stayed put.** `/api/*`, the assets,
 *      `robots.txt`, `sitemap.xml` and `llms.txt` are not pages, they are
 *      endpoints, and a redirect on an endpoint breaks a webhook. The rule
 *      sources are exact paths, so nothing else can be caught by them.
 *
 *   3. **The route tree and the redirect list agree.** The two lists are
 *      written down in two places — the filesystem and `LEGACY_ROUTES` — and
 *      this file holds them against each other, so a page added without a
 *      redirect is a test failure and not a 404 somebody finds in production.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DEFAULT_LOCALE, PUBLIC_LOCALES } from "../src/domain/i18n/locale.ts";
import { localePath } from "../src/domain/i18n/locale-path.ts";
import {
  LEGACY_ROUTES,
  legacyRedirects,
} from "../src/infrastructure/routing/legacy-redirects.ts";

const REPO = path.join(import.meta.dirname, "..");
const APP = path.join(REPO, "src/app");
const LOCALE_SEGMENT = "[locale]";

const read = (relative: string): string =>
  fs.readFileSync(path.join(REPO, relative), "utf8");

/**
 * Whether a redirect `source` matches a path.
 *
 * The sources are either an exact path or a path with one `:param` in it, so
 * this is the whole of the matching the rules need — and it is written out
 * rather than borrowed from a routing library so the test does not depend on
 * the router's own matcher to prove the router's own rules.
 */
function sourceMatches(source: string, target: string): boolean {
  const pattern = source
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`).test(target);
}

/** Every `page.tsx` under `dir`, as the route it serves. */
function pageRoutes(dir: string, prefix = ""): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...pageRoutes(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (entry.name !== "page.tsx") continue;
    routes.push(prefix === "" ? "/" : prefix);
  }
  return routes.sort();
}

test("every legacy route has a permanent redirect to the default locale", () => {
  const rules = legacyRedirects();
  assert.equal(rules.length, LEGACY_ROUTES.length);
  for (const route of LEGACY_ROUTES) {
    const rule = rules.find((candidate) => candidate.source === route);
    assert.ok(rule, `${route} has no redirect`);
    assert.equal(rule.permanent, true, `${route} must redirect permanently`);
    assert.equal(
      rule.destination,
      route === "/" ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${route}`,
      `${route} must land on its ${DEFAULT_LOCALE} equivalent`,
    );
    // A destination with a query of its own would *replace* the request's
    // query instead of adding to it, so the print selection and the session id
    // would be dropped on the way through.
    assert.doesNotMatch(
      rule.destination,
      /\?/,
      `${route} must not carry a query of its own`,
    );
  }
});

test("the legacy list is the surface that existed before the locale segment", () => {
  assert.deepEqual([...LEGACY_ROUTES].sort(), [
    "/",
    "/archive",
    "/checkout/cancel",
    "/checkout/success",
    "/contact",
    "/film",
    "/fine-art",
    "/prints/:slug",
    "/story",
  ]);
});

test("no redirect catches an API route, an asset or a machine-readable file", () => {
  const rules = legacyRedirects();
  const excluded = [
    "/api/checkout",
    "/api/contact",
    "/api/download",
    "/api/e",
    "/api/order-status",
    "/api/print-asset",
    "/api/quote",
    "/api/webhooks/stripe",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/favicon.ico",
    "/og-image.jpg",
    "/images/a-photo.webp",
    "/fonts/inter-latin-400-normal.woff2",
    "/_next/static/chunks/main.js",
  ];
  for (const target of excluded) {
    for (const rule of rules) {
      assert.equal(
        sourceMatches(rule.source, target),
        false,
        `${rule.source} must not match ${target}`,
      );
    }
  }
});

test("the redirect sources cannot match a deeper path than they name", () => {
  // `/fine-art` is a page; `/fine-art/extra` is not, and a redirect that
  // swallowed it would turn a typo into a silent 308 to the gallery.
  const rules = legacyRedirects();
  for (const rule of rules) {
    if (rule.source.includes(":")) continue;
    assert.equal(
      sourceMatches(rule.source, `${rule.source}/extra`),
      false,
      `${rule.source} must not swallow a deeper path`,
    );
  }
});

test("the print redirect carries the slug through", () => {
  const rule = legacyRedirects().find(
    (candidate) => candidate.source === "/prints/:slug",
  );
  assert.ok(rule);
  assert.equal(rule.destination, `/${DEFAULT_LOCALE}/prints/:slug`);
  assert.equal(
    sourceMatches(rule.source, "/prints/a-photo"),
    true,
    "the print route must match a slug",
  );
  assert.equal(
    sourceMatches(rule.source, "/prints/a/b"),
    false,
    "the print route takes one segment, not a path",
  );
});

test("the route tree on disk and the redirect list are the same list", () => {
  const onDisk = pageRoutes(path.join(APP, LOCALE_SEGMENT))
    .map((route) => route.replace("/[slug]", "/:slug"))
    .sort();
  assert.deepEqual(
    onDisk,
    [...LEGACY_ROUTES].sort(),
    "a page exists without a legacy redirect, or a redirect exists without a page",
  );
});

test("no public page sits outside the locale segment", () => {
  // Every page is under `/[locale]`. A page left outside it would be served
  // at a URL with no language on it, which is the shape the whole slice
  // exists to remove.
  assert.equal(
    fs.existsSync(path.join(APP, "page.tsx")),
    false,
    "the site's root page must live under the locale segment",
  );
  const outside = fs
    .readdirSync(APP, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== LOCALE_SEGMENT)
    .map((entry) => entry.name);
  assert.deepEqual(
    outside.filter((name) => name !== "api" && name !== "llms.txt"),
    [],
    "only /api and the machine-readable /llms.txt may sit beside the locale segment",
  );
});

test("the endpoints that must not move are still outside the locale segment", () => {
  for (const relative of [
    "src/app/api/checkout/route.ts",
    "src/app/api/download/route.ts",
    "src/app/robots.ts",
    "src/app/sitemap.ts",
    "src/app/llms.txt/route.ts",
    "src/app/globals.css",
  ]) {
    assert.ok(
      fs.existsSync(path.join(REPO, relative)),
      `${relative} must stay outside the locale segment`,
    );
  }
});

test("there is one document layout, and it owns the language of the page", () => {
  // A root layout outside the locale segment *and* one inside it would be two
  // documents, and the outer one would win the `<html lang>`.
  assert.equal(
    fs.existsSync(path.join(APP, "layout.tsx")),
    false,
    "there must be exactly one document layout",
  );
  const layout = read("src/app/[locale]/layout.tsx");
  assert.match(layout, /<html lang=\{locale\}/);
  // The language is rendered on the server, in the document, not set by a
  // client effect: a crawler reads the HTML, and an effect runs after it.
  assert.doesNotMatch(layout, /useEffect/);
  assert.doesNotMatch(layout, /"use client"/);
});

test("a locale segment the site does not serve is a 404", () => {
  const layout = read("src/app/[locale]/layout.tsx");
  // `dynamicParams = false` makes the router refuse a segment that was not
  // generated, before any component runs: `/de` is a page that does not exist
  // rather than an English page under a German URL.
  assert.match(layout, /export const dynamicParams = false/);
  // And the generated segments come from the registry, so a locale cannot be
  // served without being in it.
  assert.match(layout, /PUBLIC_LOCALES\.map\(\(locale\) => \(\{ locale \}\)\)/);
  assert.deepEqual([...PUBLIC_LOCALES], ["en"]);
});

test("the switcher maps a URL to the same page in another language", () => {
  // The switcher holds the URL it is on and asks for the same URL in the
  // other language. The route, the photo slug and the query string all
  // survive, in both directions.
  const cases: Array<[string, string]> = [
    ["/en", "/bg"],
    ["/en/fine-art", "/bg/fine-art"],
    ["/en/prints/a-photo", "/bg/prints/a-photo"],
    ["/en/prints/a-photo?format=framed&size=a4", "/bg/prints/a-photo?format=framed&size=a4"],
    ["/en/checkout/success?session_id=cs_test_123", "/bg/checkout/success?session_id=cs_test_123"],
    ["/en/story#contact", "/bg/story#contact"],
  ];
  for (const [from, to] of cases) {
    assert.equal(localePath("bg", from), to, `${from} must map to ${to}`);
    assert.equal(localePath("en", to), from, `${to} must map back to ${from}`);
  }
});

test("the switcher is in both navigations, and it is a link", () => {
  const header = read("src/components/SiteHeader.tsx");
  const mobile = read("src/components/MobileNav.tsx");
  const switcher = read("src/components/i18n/LanguageSwitcher.tsx");

  // A control that hides the other language behind a click handler is
  // invisible to a crawler, to a keyboard and to a browser with scripting
  // off. A link is all three.
  assert.match(switcher, /<Link/);
  assert.doesNotMatch(switcher, /onClick/);
  // The current language is named, and the switcher's own label is localized.
  assert.match(switcher, /aria-label=\{dictionary\.language\.label\}/);
  assert.match(switcher, /LOCALE_NAMES\[locale\]/);
  // The languages it offers are the ones the site serves, taken from the
  // registry rather than from a list of its own.
  assert.match(switcher, /locales = PUBLIC_LOCALES/);

  // The switcher sits in the desktop bar and in the mobile panel: a control
  // the visitor cannot see is not a control they can use.
  assert.match(header, /<LanguageSwitcher locale=\{locale\} \/>/);
  assert.match(mobile, /<LanguageSwitcher locale=\{locale\} \/>/);
});

test("every link on a page is built by the one path helper", () => {
  // A hand-written `href="/prints/..."` is a link with no language on it: it
  // lands on the legacy URL, which redirects, which is a hop every visitor
  // pays for a page the site already knows the URL of.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      if (/href=\{?"\/(?!api\/)/.test(source)) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  walk(path.join(REPO, "src"));
  assert.deepEqual(
    offenders,
    [],
    "these files hard-code a public link; every public URL goes through localePath",
  );
});

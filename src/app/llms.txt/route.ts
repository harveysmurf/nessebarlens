import { CATEGORY } from "@/domain/catalog/categories";
import { PHOTO_CATEGORIES } from "@/domain/catalog/photo-schema";
import { DEFAULT_LOCALE, PUBLIC_LOCALES } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { INDEXABLE_ROUTES, canonicalUrl, seoOrigin } from "@/infrastructure/seo/page-metadata";

/**
 * `/llms.txt`, built per environment rather than shipped as a static file.
 *
 * This was `public/llms.txt` with the production URLs written into it, which is
 * wrong in a way only CI could catch: `public/` is copied verbatim into
 * `.open-next`, so the staging artifact carried seven references to
 * `https://nessebarlens.com` and `scripts/assert-artifact-origin.sh` refused to
 * deploy it. That script exists because a build for one environment shipping
 * another's canonicals is a live-site bug, and a hand-written file in `public/`
 * is the easiest way to cause exactly that — the string never passes through
 * the build, so nothing about building for staging changes it.
 *
 * As a route it reads `seoOrigin()`, the same reader `sitemap.ts` and
 * `robots.ts` use, so a staging build emits staging URLs and the artifact
 * assertion passes for the right reason.
 *
 * Left dynamic while `sitemap.ts` and `robots.ts` are prerendered, deliberately:
 * this handler reads the origin at *request* time, from the `NEXT_PUBLIC_SITE_URL`
 * var the Worker always carries (`wrangler.toml` sets it per environment). A
 * prerendered `llms.txt` would bake the build's value into a file that is then
 * served — and a build missing that variable bakes `http://localhost:3000` into
 * the answer, which `assert-artifact-origin.sh` cannot catch because it only
 * looks for the expected origin, not for a fallback. The cost is one Worker
 * invocation per request for a file crawlers read rarely.
 *
 * Kept in one `get` so the body and its `Content-Type` cannot drift: a route
 * handler that forgot the header would serve the text as HTML.
 */

/** One line of prose per page. The title comes from the route, not from here. */
const PAGE_NOTES: Record<string, string> = {
  "/": "The featured photograph and an entry point to each of the three galleries.",
  "/fine-art":
    "The curated portfolio — composed architecture, atmospheric coastlines, and colour graded for print.",
  "/archive": "Photojournalistic work: everyday street life in Nessebar over thirty years.",
  "/film": "Analog 35mm and 120 film negatives, unedited grain and light leaks included.",
  "/story": "How the three bodies of work relate, and how a print is made.",
  "/contact": "Direct contact with the studio about a print, a licence, or an order.",
};

const HEADER = `# Nessebar Lens

Fine art, archive, and film photography of Old Town Nessebar, Bulgaria, by a
single photographer working across three decades. Photographs are sold as
museum-quality giclée prints produced by a print partner, and as high-resolution
digital downloads. There is no subscription, no account, and no cart to persist:
checkout is a single Stripe-hosted page.

The canonical machine-readable index of this site is the sitemap:`;

const FOOTER = `## Individual photographs

Each photograph has its own page at \`/${DEFAULT_LOCALE}/prints/{slug}\` carrying the title, the
full description, the print sizes available, and the price. The complete list is
in the sitemap; it is not repeated here because it changes with every publish.

## Not indexed

The checkout pages (\`/${DEFAULT_LOCALE}/checkout/success\`, \`/${DEFAULT_LOCALE}/checkout/cancel\`) are per-session and
carry \`noindex\`. They are not in the sitemap and should not be requested.`;

export function GET(): Response {
  const origin = seoOrigin();

  const pages = PUBLIC_LOCALES.flatMap((locale) =>
    INDEXABLE_ROUTES.map((route) => {
      const label = route === "/" ? "Home" : titleFor(route);
      const url = canonicalUrl(localePath(locale, route));
      return `- [${label}](${url}): ${PAGE_NOTES[route]}`;
    }),
  ).join("\n");

  const body = [
    HEADER,
    `${origin}/sitemap.xml`,
    "",
    "## Pages",
    "",
    pages,
    "",
    FOOTER,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * The page's own name.
 *
 * The three gallery routes take `navLabel` from `CATEGORY` — the same field the
 * nav and the footer read — so the file says "Film Photography" rather than the
 * slug's "Film", without this becoming a second naming table. The two prose
 * routes have no category and fall through to their segment in title case.
 */
function titleFor(route: string): string {
  const category = PHOTO_CATEGORIES.find((c) => CATEGORY[c].href === route);
  if (category) return CATEGORY[category].navLabel;

  const segment = route.replace(/^\//, "").replace(/-/g, " ");
  return toTitleCase(segment);
}

function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
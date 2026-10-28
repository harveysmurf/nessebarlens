import type { Metadata } from "next";
import localFont from "next/font/local";
import { AnalyticsBeacon } from "@/components/AnalyticsBeacon";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { getDictionary } from "@/components/i18n/dictionaries";
import { NODE_ENV } from "@/infrastructure/config/env";
import { servedLocales } from "@/infrastructure/i18n/served-locales";
import { sitewideJsonLd } from "@/infrastructure/seo/json-ld";
import {
  HOME_COPY,
  OG_IMAGE,
  SITE_TITLE,
  seoOrigin,
} from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "./locale-param";
import "../globals.css";

const cormorant = localFont({
  variable: "--font-cormorant",
  display: "swap",
  src: [
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-300-normal.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-300-italic.woff2",
      weight: "300",
      style: "italic",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-500-italic.woff2",
      weight: "500",
      style: "italic",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-latin-600-italic.woff2",
      weight: "600",
      style: "italic",
    },
  ],
});

const inter = localFont({
  variable: "--font-inter",
  display: "swap",
  src: [
    {
      path: "../../fonts/inter/inter-latin-200-normal.woff2",
      weight: "200",
      style: "normal",
    },
    {
      path: "../../fonts/inter/inter-latin-300-normal.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../../fonts/inter/inter-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/inter/inter-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../fonts/inter/inter-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
});

/*
 * The Cyrillic half of the same two families.
 *
 * A separate family rather than more entries in the lists above, because the
 * two sets are disjoint: the Latin subset has no Cyrillic glyph at all, and a
 * browser picking between two faces of one family has no rule that says which
 * one wins for a character the other lacks. Two families in a stack have that
 * rule — the browser walks the list per character — which is why `globals.css`
 * lists the Cyrillic family after the Latin one.
 *
 * One variable file per family and style, covering the weight range the file
 * declares: the Latin files above are static instances, but the Cyrillic
 * subsets are vendored as the variable font they were published as, and the
 * range in `weight` is the range the file actually carries.
 */
const interCyrillic = localFont({
  variable: "--font-inter-cyrillic",
  display: "swap",
  src: [
    {
      path: "../../fonts/inter/inter-cyrillic-variable-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
  ],
});

const cormorantCyrillic = localFont({
  variable: "--font-cormorant-cyrillic",
  display: "swap",
  src: [
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-cyrillic-variable-normal.woff2",
      weight: "300 700",
      style: "normal",
    },
    {
      path: "../../fonts/cormorant-garamond/cormorant-garamond-cyrillic-variable-italic.woff2",
      weight: "300 700",
      style: "italic",
    },
  ],
});

// Same helper the Stripe origin uses, so there is one spelling of the site URL
// and the localhost fallback matches; metadataBase makes relative image paths
// absolute for the OG/Twitter crawlers.
//
// The root's own title and description are `HOME_COPY`, which is the same object
// `PAGE_COPY["/"]` holds, and `/` exports the same pair through
// `pageMetadata("/")`. They are stated here rather than merged up from the
// homepage page segment, because a root layout cannot read a child segment's
// metadata: a page that forgot to export any would otherwise inherit the root's
// words, which is the bug this change exists to close. One shared constant is
// the price of that, not a second hand-written string.
//
// `metadataBase` is the only field here that no page should repeat — it is what
// makes `alternates.canonical` and the relative OG image absolute, and a child
// layout that re-declared it would silently change the origin of every route
// below it.

export const metadata: Metadata = {
  title: HOME_COPY.title,
  description: HOME_COPY.description,
  metadataBase: new URL(seoOrigin()),
  openGraph: {
    type: "website",
    siteName: SITE_TITLE,
    title: HOME_COPY.title,
    description: HOME_COPY.description,
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: SITE_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_COPY.title,
    description: HOME_COPY.description,
    images: [OG_IMAGE],
  },
};

/**
 * The locales this route tree is built for.
 *
 * The list is the served one, so the routes that exist and the locales the
 * site serves cannot disagree. A locale that is known but not served —
 * Bulgarian, until the page, contact and checkout slices land — has no route
 * here and no page anywhere that could serve it.
 *
 * The served list is read through `servedLocales(NODE_ENV)`, which outside a
 * production build can add locales for the dev server and the e2e job. A
 * production build serves exactly the registry's public list, whatever the
 * environment says.
 */
export function generateStaticParams() {
  return servedLocales(NODE_ENV).map((locale) => ({ locale }));
}

/**
 * A locale segment that is not in the list above is a 404.
 *
 * `dynamicParams: false` says so at the routing level, before any component
 * runs, so `/de` is not an English page under a German URL and `/bg` is not
 * a half-translated Bulgarian one: both are a page that does not exist.
 */
export const dynamicParams = false;

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale: raw } = await params;
  // Unreachable while `dynamicParams` is false, and the reason it can stay
  // unreachable: the guard is the second line of defence for a route that was
  // somehow reached with a locale the site does not have.
  const locale = requireLocale(raw);
  // The dictionary is read here, on the server, and handed to the client
  // components as the slices they render: the whole dictionary would travel to
  // every browser that loaded the header.
  const copy = getDictionary(locale);
  const locales = servedLocales(NODE_ENV);

  return (
    <html lang={locale} className="scroll-smooth" data-scroll-behavior="smooth">
      <body
        className={`${cormorant.variable} ${inter.variable} ${cormorantCyrillic.variable} ${interCyrillic.variable} font-sans antialiased selection:bg-stone-900 selection:text-white flex flex-col min-h-screen bg-gallery-50 text-gallery-900`}
      >
{/*
          Sitewide Organization + WebSite, before anything a page renders:
          JSON-LD belongs to the document, not to the page's content, and this
          is the only place a crawler can be sure to find it.
        */}
        <JsonLd data={sitewideJsonLd()} />
        <AnalyticsBeacon />
        <SiteHeader
          locale={locale}
          copy={{ nav: copy.nav, language: copy.language }}
          locales={locales}
        />
        <main className="flex-1">{children}</main>
        <SiteFooter copy={copy.footer} />
      </body>
    </html>
  );
}

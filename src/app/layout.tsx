import type { Metadata } from "next";
import localFont from "next/font/local";
import { AnalyticsBeacon } from "@/components/AnalyticsBeacon";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { sitewideJsonLd } from "@/infrastructure/seo/json-ld";
import {
  HOME_COPY,
  OG_IMAGE,
  SITE_TITLE,
  seoOrigin,
} from "@/infrastructure/seo/page-metadata";
import "./globals.css";

const cormorant = localFont({
  variable: "--font-cormorant",
  display: "swap",
  src: [
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-300-normal.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-300-italic.woff2",
      weight: "300",
      style: "italic",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-500-italic.woff2",
      weight: "500",
      style: "italic",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../fonts/cormorant-garamond/cormorant-garamond-latin-600-italic.woff2",
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
      path: "../fonts/inter/inter-latin-200-normal.woff2",
      weight: "200",
      style: "normal",
    },
    {
      path: "../fonts/inter/inter-latin-300-normal.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../fonts/inter/inter-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/inter/inter-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../fonts/inter/inter-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth" data-scroll-behavior="smooth">
      <body
        className={`${cormorant.variable} ${inter.variable} font-sans antialiased selection:bg-stone-900 selection:text-white flex flex-col min-h-screen bg-gallery-50 text-gallery-900`}
      >
{/*
          Sitewide Organization + WebSite, before anything a page renders:
          JSON-LD belongs to the document, not to the page's content, and this
          is the only place a crawler can be sure to find it.
        */}
        <JsonLd data={sitewideJsonLd()} />
        <AnalyticsBeacon />
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

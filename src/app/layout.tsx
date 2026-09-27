import type { Metadata } from "next";
import localFont from "next/font/local";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
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

export const metadata: Metadata = {
  title: "Stefan Todorov — Nessebar Lens",
  description:
    "Fine art, archive, and film photography from Old Town Nessebar. Museum-quality prints and digital downloads.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={`${cormorant.variable} ${inter.variable} font-sans antialiased selection:bg-stone-900 selection:text-white flex flex-col min-h-screen bg-gallery-50 text-gallery-900`}
      >
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

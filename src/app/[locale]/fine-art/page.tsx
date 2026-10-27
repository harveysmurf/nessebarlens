import type { Metadata } from "next";
import { GalleryPage } from "@/components/GalleryPage";
import { isLocale } from "@/domain/i18n/locale";
import { categoryMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../locale-param";

/**
 * The route's own words, from the one table in `page-metadata.ts`, for the
 * language this page is in.
 *
 * A function rather than a constant because the canonical now carries the
 * locale segment: `/en/fine-art` and `/bg/fine-art` are different URLs for
 * the same words, and a constant cannot say which one it is.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return categoryMetadata("fine-art", locale);
}

export default async function FineArtPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);
  return <GalleryPage category="fine-art" locale={locale} />;
}

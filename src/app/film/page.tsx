import { Metadata } from "next";
import { GalleryPage } from "@/components/GalleryPage";
import { categoryMetadata } from "@/infrastructure/seo/page-metadata";

/** The route's own words, from the one table in `page-metadata.ts`. */
export const metadata: Metadata = categoryMetadata("film");

export default function FilmPage() {
  return <GalleryPage category="film" />;
}

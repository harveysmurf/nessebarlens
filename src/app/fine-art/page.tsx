import { Metadata } from "next";
import { GalleryPage } from "@/components/GalleryPage";
import { categoryMetadata } from "@/infrastructure/seo/page-metadata";

/** The route's own words, from the one table in `page-metadata.ts`. */
export const metadata: Metadata = categoryMetadata("fine-art");

export default function FineArtPage() {
  return <GalleryPage category="fine-art" />;
}

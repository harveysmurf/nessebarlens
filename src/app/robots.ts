/**
 * `/robots.txt`, generated so it can name the sitemap.
 *
 * Before this the file was Cloudflare's content-signals policy with no
 * `Sitemap:` line, so a crawler had no pointer to the map. Adding the route is
 * the fix; note that a Cloudflare-managed `robots.txt` can override it, which
 * is checked by curling production after deploy rather than assumed here.
 *
 * Only the sitemap line. `allow: "/"` and no `Disallow` is a deliberate
 * statement, not an omission: the two routes that should not be crawled already
 * say so with `robots: { index: false }` in their own metadata, and a
 * `Disallow` here would be a second copy of that decision to keep in step. The
 * `/api/` routes need no rule either — they return JSON, which no crawler
 * indexes as a page.
 */

import type { MetadataRoute } from "next";
import { seoOrigin } from "@/infrastructure/seo/page-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${seoOrigin()}/sitemap.xml`,
  };
}
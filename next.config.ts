import type { NextConfig } from "next";

// NEXT_PUBLIC_* is inlined at build time, so a build missing the site url
// cannot be repaired by a later deploy: it ships a checkout that redirects to
// http://localhost:3000 and Prodigi orders whose asset URL is unreachable.
// Failing here turns a silent production breakage into a red build. Only the
// production build is asserted — `next dev` and `npm test` run without it.
if (
  process.env.NODE_ENV === "production" &&
  !process.env.NEXT_PUBLIC_SITE_URL?.trim()
) {
  throw new Error(
    "NEXT_PUBLIC_SITE_URL is required for a production build. Set it in the " +
      "GitHub production/preview environment.",
  );
}

const nextConfig: NextConfig = {
  // Gallery uses plain <img> srcset against NEXT_PUBLIC_WEB_IMAGES_BASE only.
  // No remotePatterns — do not allow images.unsplash.com or other third-party hosts.
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;

// Initialize OpenNext Cloudflare for local `next dev` bindings when present.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

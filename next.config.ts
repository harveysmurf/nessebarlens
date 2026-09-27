import type { NextConfig } from "next";

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

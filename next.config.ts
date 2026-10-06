import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

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
  // Next 16 blocks cross-origin requests to dev resources (/_next/*, the HMR
  // socket) and trusts only localhost by default. Playwright drives the dev
  // server on 127.0.0.1 (playwright.config.ts), so without this the page
  // never hydrates: the configurator never calls /api/quote and the @hosted
  // physical-print spec times out on a Checkout button that stays disabled.
  // Dev-only; `next build` ignores it.
  allowedDevOrigins: ["127.0.0.1"],
  // Gallery uses plain <img> srcset against NEXT_PUBLIC_WEB_IMAGES_BASE only.
  // No remotePatterns — do not allow images.unsplash.com or other third-party hosts.
  images: {
    remotePatterns: [],
  },
  // The success page URL carries a Stripe session id and, for a digital order,
  // is the only place the download token is rendered (#111). `no-referrer` stops
  // this response from naming either one to anything the page loads or links to;
  // `private, no-store` keeps a paid order's page out of shared caches, matching
  // what /api/download already sends on every response.
  async headers() {
    return [
      {
        source: "/checkout/success",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;

// Initialize OpenNext Cloudflare for local `next dev` bindings, dev-only.
//
// The guard is load-bearing, not a nicety: next.config.ts is evaluated by every
// process that builds or serves the app, and `next build` runs its prerender
// workers with NODE_ENV=production. Without the guard each of those would call
// initOpenNextCloudflareForDev(), boot a local Workers runtime, and contend on
// the same `.wrangler/state` SQLite file -- the SQLITE_BUSY "database is
// locked" that failed `Build (production)` and blocked deploys (#227).
// opennextjs-cloudflare's own dedupe is the AsyncLocalStorage heuristic in
// cloudflare-context.js, which is aimed at the two `next dev` processes, not the
// many `next build` workers, so it does not protect the build.
//
// In CI the dev bindings are in-memory (`persist: false`) so the two `next dev`
// processes cannot share the `.wrangler/state` SQLite file either — the e2e seed
// is in-memory Maps (orders-dev-seed.ts), so nothing the smoke flow reads needs
// disk persistence, and dropping it removes the SQLITE_BUSY race seen on #228.
// A local `next dev` keeps the default persistence.
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev(process.env.CI ? { persist: false } : undefined);
}

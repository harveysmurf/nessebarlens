import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import {
  originOf,
  securityHeaders,
  // Extensionless, like every other import in this repo. `next.config.ts` has
  // no tsconfig paths alias, so this is a relative specifier — and the module it
  // pulls in imports nothing, which is what keeps the workerd probe in
  // tests/fixtures/next-config-init-probe.mjs able to evaluate the real config
  // under a bare `node`.
} from "./src/infrastructure/seo/security-headers";
import { legacyRedirects } from "./src/infrastructure/routing/legacy-redirects";
import { NODE_ENV } from "./src/infrastructure/config/env";
import { servedLocales } from "./src/infrastructure/i18n/served-locales";

// The one origin outside the site itself that the browser must be allowed to
// load images from: the R2 custom domain behind NEXT_PUBLIC_WEB_IMAGES_BASE.
// Read here, at config-evaluation time, because headers() is a pure function of
// the build — NEXT_PUBLIC_* is inlined the same way, so the policy and the
// ladder can never disagree about which deploy they belong to.
const IMAGE_ORIGIN = originOf(process.env.NEXT_PUBLIC_WEB_IMAGES_BASE);

// The production policy and the dev policy are the same string except for one
// token. React's development build calls eval(); React's production build never
// does. Narrowing it to development is what lets the Playwright suite — which
// runs `next dev` — still exercise every origin and directive in the policy
// without a console error on every page load, while what deploys keeps the token
// out. `tests/security-headers.test.mts` asserts the two differ by exactly this.
const CSP_OPTIONS = {
  allowEval: process.env.NODE_ENV === "development",
};

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
  //
  // The site-wide rule comes FIRST and this one second, because Next resolves
  // overlapping header keys last-wins: the wildcard sets Referrer-Policy, and
  // `no-referrer` below is the narrower statement that has to beat it. Swapping
  // the two would quietly downgrade the paid page to the site-wide policy.
  //
  // `/:path*` covers `/` too (`:path*` matches zero or more segments), and the
  // static bundle is not covered: content-hashed assets are served by the
  // ASSETS binding and bypass next.config entirely, so a CSP assertion that
  // reads a header off `/_next/static/...` measures the wrong server.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(IMAGE_ORIGIN, CSP_OPTIONS),
      },
      // The success page moved under the locale segment, so the rule that keeps
      // a paid order's page out of shared caches follows it there. The locales
      // come from the registry, so the rule cannot name a language the site
      // does not serve — and it is spelled out per locale rather than as
      // `/:locale/checkout/success`, which would also match `/api/checkout/...`.
      //
      // The legacy path keeps its own rule because the redirect response is a
      // response too, and it is the one a shared cache would store.
      ...servedLocales(NODE_ENV).map((locale) => ({
        source: `/${locale}/checkout/success`,
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
      {
        source: "/checkout/success",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  // Every public page moved under a locale segment, so the URLs that were
  // already published have to keep working. The rules are one per legacy
  // route and nothing else: the sources are exact paths, so `/api/*`, the
  // assets, `robots.txt`, `sitemap.xml` and `llms.txt` are never caught by
  // them, and the query string is carried over to the new path.
  async redirects() {
    return legacyRedirects();
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

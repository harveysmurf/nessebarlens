import Script from "next/script";
import { seoOrigin } from "@/infrastructure/seo/page-metadata";

/**
 * Cloudflare Web Analytics beacon (#119).
 *
 * The manual snippet, not edge injection: this site is served by an OpenNext
 * Worker (`x-opennext: 1`), and Cloudflare does not inject the beacon into
 * Worker-generated HTML — verified on apex and www with zero matches for
 * `cloudflareinsights`. `auto_install` is off so there is no double-count if
 * that ever changes.
 *
 * `send.to` is not optional here. Without it the beacon posts to the relative
 * `/cdn-cgi/rum`, which this Worker answers with a 404 (plain Cloudflare error
 * page, no `x-opennext` header), so every pageview is dropped silently. The
 * shipped `beacon.min.js` only falls back to the apex endpoint when
 * `window.__cfBeacon.version` is undefined — and the hand-placed snippet always
 * sets it, so the fallback never fires. Pinning the endpoint is what makes the
 * write reach Cloudflare. `connect-src` already allows this origin; see
 * `RUM_ORIGIN` in `security-headers.ts`.
 *
 * Rendered only on a non-local origin: `next dev` and the local test runs served
 * roughly 1,200 pageviews a day as `localhost` / `127.0.0.1` before this gate,
 * and the free plan has no rules to filter them out. Staging still reports — its
 * host is not local — and is tagged by the WA hostname dimension.
 *
 * The token is public (it ships in every page's HTML) and belongs in source.
 * `afterInteractive` keeps the script off the render-blocking path, so it
 * cannot move the LCP candidate.
 */
/** The script origin. Exported so the CSP test asserts the same string. */
export const BEACON_SCRIPT =
  "https://static.cloudflareinsights.com/beacon.min.js";
const BEACON_TOKEN = "f0786d2b56694ea6b045ac75545033b8";

/** Where the beacon reports. Cross-origin, so the Worker cannot swallow it. */
export const BEACON_ENDPOINT =
  "https://cloudflareinsights.com/cdn-cgi/rum";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether a page served from `origin` should report to Web Analytics.
 *
 * False for local hosts and for anything that does not parse: a beacon from a
 * dev server is noise in a dataset with no way to remove it.
 */
export function isTrackableOrigin(origin: string): boolean {
  try {
    return !LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function AnalyticsBeacon({
  origin = seoOrigin(),
}: {
  origin?: string;
} = {}) {
  const config = analyticsBeaconConfig(origin);
  if (!config) return null;

  return (
    <Script
      src={BEACON_SCRIPT}
      strategy="afterInteractive"
      data-cf-beacon={config}
    />
  );
}

/**
 * The `data-cf-beacon` value for `origin`, or null when this origin must not
 * report. Exported so the contract is testable without rendering `next/script`,
 * which emits nothing to `renderToStaticMarkup`.
 */
export function analyticsBeaconConfig(origin: string): string | null {
  if (!isTrackableOrigin(origin)) return null;
  return JSON.stringify({
    token: BEACON_TOKEN,
    send: { to: BEACON_ENDPOINT },
  });
}


import Script from "next/script";
import { seoOrigin } from "@/infrastructure/seo/page-metadata";

/**
 * Cloudflare Web Analytics beacon (#119).
 *
 * The manual snippet, not edge injection — and the reason is configuration, not
 * the Worker. Cloudflare's automatic injection **does** reach this site's HTML:
 * it fires only for browser-like user agents, so a `curl` of `/` shows nothing
 * and "zero matches for `cloudflareinsights`" was a measurement of curl, not of
 * the site. Web Analytics is in manual-installation mode (`auto_install=false`,
 * ruleset disabled — "Enable with JS Snippet installation" in the dashboard), so
 * nothing injects and this is the only beacon. The zone RUM setting reads
 * `manual` and is derived from that site config, not the other way round; it is
 * rejected when PATCHed, so it is a symptom to read, never the thing to change.
 *
 * That is a runtime invariant, not a preference. With both on, the injected
 * snippet seeded `window.__cfBeacon` and this one merged into it, which dropped
 * `send.to`: the endpoint resolved to null and zero pageviews were sent while
 * every status check stayed green. So `scripts/smoke.sh` fetches `/` with a
 * browser-like UA and fails the release when the body carries more than one
 * beacon — the count, not the presence, because a presence check is satisfied by
 * the injector alone.
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
 * cannot move the LCP candidate. It is also why the served HTML carries a
 * preload link and an RSC payload entry for this src but no `<script>` tag:
 * Next creates the element at runtime, and the smoke's injection check reads
 * that absence as its signal.
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


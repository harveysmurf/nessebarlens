import Script from "next/script";

/**
 * Cloudflare Web Analytics beacon (#119).
 *
 * The manual snippet, not edge injection: this site is served by an OpenNext
 * Worker (`x-opennext: 1`), and Cloudflare does not inject the beacon into
 * Worker-generated HTML — verified on apex and www with zero matches for
 * `cloudflareinsights`. `auto_install` is off so there is no double-count if
 * that ever changes.
 *
 * The token is public (it ships in every page's HTML) and belongs in source.
 * `afterInteractive` keeps the script off the render-blocking path, so it
 * cannot move the LCP candidate.
 */
export function AnalyticsBeacon() {
  return (
    <Script
      src="https://static.cloudflareinsights.com/beacon.min.js"
      strategy="afterInteractive"
      data-cf-beacon='{"token":"f0786d2b56694ea6b045ac75545033b8"}'
    />
  );
}

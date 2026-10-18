/**
 * The Web Analytics beacon (#119).
 *
 * Three failures this pins, all of which were live before the endpoint was
 * pinned:
 *
 * - **the relative endpoint.** With `data-cf-beacon` present the shipped
 *   `beacon.min.js` posts to `/cdn-cgi/rum`, and this Worker answers 404. The
 *   beacon catches its own error, so the page looks fine and WA records nothing.
 *   The assertion is the absolute URL in the rendered attribute.
 * - **the localhost flood.** Dev and test runs rendered the beacon and WA
 *   recorded them as pageviews (`localhost` / `127.0.0.1`), which the free plan
 *   cannot filter out. Local origins must render nothing.
 * - **the token.** The site token is what attribution hangs on; a typo is a
 *   silent zero.
 *
 * The assertions are on `analyticsBeaconConfig`, not on rendered markup:
 * `next/script` with `afterInteractive` renders nothing to
 * `renderToStaticMarkup`, so a markup assertion here would pass vacuously.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BEACON_ENDPOINT,
  analyticsBeaconConfig,
  isTrackableOrigin,
} from "../src/components/AnalyticsBeacon.tsx";

const SITE = "https://nessebarlens.com";

type BeaconConfig = {
  token?: string;
  send?: { to?: string };
};

function configFor(origin: string): BeaconConfig | null {
  const raw = analyticsBeaconConfig(origin);
  return raw === null ? null : (JSON.parse(raw) as BeaconConfig);
}

test("the beacon reports to the apex RUM endpoint, not the relative path", () => {
  const config = configFor(SITE);
  assert.ok(config);
  assert.equal(config.send?.to, BEACON_ENDPOINT);
  assert.equal(BEACON_ENDPOINT, "https://cloudflareinsights.com/cdn-cgi/rum");
  assert.equal(config.token, "f0786d2b56694ea6b045ac75545033b8");
});

test("local origins configure no beacon", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:8787",
    "http://[::1]:3000",
  ]) {
    assert.equal(configFor(origin), null, origin);
  }
});

test("staging and production configure the beacon", () => {
  for (const origin of [SITE, "https://staging.nessebarlens.com"]) {
    assert.ok(configFor(origin), origin);
  }
});

test("isTrackableOrigin rejects local hosts and unparseable values", () => {
  assert.equal(isTrackableOrigin(SITE), true);
  assert.equal(isTrackableOrigin("http://localhost:3000"), false);
  assert.equal(isTrackableOrigin("http://127.0.0.1"), false);
  assert.equal(isTrackableOrigin("not a url"), false);
});

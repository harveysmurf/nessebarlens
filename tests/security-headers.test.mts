/**
 * The security headers, and the Content-Security-Policy in particular.
 *
 * A CSP is the one header where a plausible-looking mistake is invisible until
 * a customer sees it: drop Turnstile from `script-src` and the contact form
 * fails to render a widget, with no error in our logs. So the tests here assert
 * each directive and each origin by name rather than snapshotting the string —
 * a snapshot would be updated in the same commit as the mistake.
 *
 * The module under test imports nothing (`src/infrastructure/seo/security-headers.ts`),
 * because `next.config.ts` imports *it* into the workerd probe in
 * `no-workerd-in-build.test.mts`. That probe runs under a bare `node` with only
 * a resolve hook for `@opennextjs/cloudflare`, so a dependency on
 * `config/config.ts` here would drag the Prodigi readers into it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ANALYTICS_ORIGIN,
  contentSecurityPolicy,
  originOf,
  RUM_ORIGIN,
  securityHeaders,
  TURNSTILE_ORIGIN,
} from "../src/infrastructure/seo/security-headers.ts";

const IMAGE_ORIGIN = "https://images.nessebarlens.com";
const CSP = contentSecurityPolicy(IMAGE_ORIGIN);

/** One directive's sources, e.g. `directive("img-src")` → "'self' data: blob: …". */
function directive(name: string): string {
  const found = CSP.split("; ")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  assert.ok(found, `the policy has no ${name} directive:\n${CSP}`);
  return found;
}

test("every directive the site depends on is present", () => {
  // Enumerated rather than snapshotted, and each one has a reason it is here.
  for (const name of [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "connect-src",
    "frame-src",
    "worker-src",
    "manifest-src",
    "object-src",
    "base-uri",
    "frame-ancestors",
  ]) {
    assert.ok(directive(name).startsWith(name), `missing ${name}`);
  }
});

test("nothing can be framed, plugin-loaded or base-hijacked", () => {
  assert.equal(directive("object-src"), "object-src 'none'");
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive("base-uri"), "base-uri 'self'");
  assert.equal(directive("default-src"), "default-src 'self'");
});

test("Turnstile is allowed to load a script and to run a widget frame", () => {
  // The contact form's whole submission path. A regression here is invisible in
  // CI — it is a customer seeing a form that will not send.
  assert.match(directive("script-src"), new RegExp(TURNSTILE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(directive("frame-src"), `frame-src ${TURNSTILE_ORIGIN}`);
});

test("the analytics beacon may load its script and report to where it reports", () => {
  // Two hosts, asserted separately, because the failure is silent: block the
  // report host and the beacon still loads, still runs, and swallows the error,
  // so every pageview is dropped with nothing red anywhere. The previous
  // version of this test asserted the *script* origin in `connect-src`, which
  // passed while doing exactly that (#438 review).
  assert.match(directive("script-src"), new RegExp(escape(ANALYTICS_ORIGIN)));
  assert.match(directive("connect-src"), new RegExp(escape(RUM_ORIGIN)));

  assert.notEqual(
    RUM_ORIGIN,
    ANALYTICS_ORIGIN,
    "if these are ever the same host again, one of them is wrong: the beacon is " +
      "served from static.cloudflareinsights.com and reports to cloudflareinsights.com",
  );
});

test("the report host is the one the shipped beacon actually calls", () => {
  // Ties the constant to the component that ships it, so changing the beacon's
  // src without widening the policy — or widening the policy without needing it
  // — is a failing test rather than a silent drop of the analytics.
  const beacon = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "components", "AnalyticsBeacon.tsx"),
    "utf8",
  );
  const src = /src="(https:\/\/[^"]+)"/.exec(beacon)?.[1];
  assert.ok(src, "AnalyticsBeacon.tsx no longer carries an absolute script src");

  const origin = new URL(src).origin;
  assert.equal(
    origin,
    ANALYTICS_ORIGIN,
    `the beacon loads from ${origin}, but script-src allows ${ANALYTICS_ORIGIN}`,
  );
  assert.doesNotMatch(
    directive("connect-src"),
    new RegExp(escape(ANALYTICS_ORIGIN)),
    "connect-src names the script origin, which is where the beacon is loaded " +
      "from, not where it reports to. That is the mistake, not the fix.",
  );
});

/** A host as a regular expression, so a dot in it is not a wildcard. */
function escape(origin: string): string {
  return origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("images come from the R2 base the gallery actually uses", () => {
  const img = directive("img-src");
  assert.match(img, /^img-src 'self' data: blob:/);
  assert.ok(
    img.includes(IMAGE_ORIGIN),
    `img-src does not name ${IMAGE_ORIGIN}. Without it every gallery <img> is ` +
      `blocked and the site renders as empty boxes.`,
  );
});

test("the configurator's blob preview is allowed", () => {
  // PrintConfigurator previews the chosen file from a blob: URL before upload.
  assert.match(directive("img-src"), /blob:/);
});

test("'unsafe-inline' is in scripts and styles, and the reason is written down", () => {
  // Not an oversight to be tidied away: Next's bootstrap script and React's
  // hydration payload are inline, and a nonce migration is a separate change
  // with its own staging proof.
  assert.match(directive("script-src"), /'unsafe-inline'/);
  assert.match(directive("style-src"), /'unsafe-inline'/);

  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "infrastructure", "seo", "security-headers.ts"),
    "utf8",
  );
  assert.match(
    source,
    /nonce/,
    "the reason 'unsafe-inline' is required has to stay next to the policy, or " +
      "the next reader removes it and turns the contact form into a silent failure",
  );
});

test("HSTS is not here — it is set once at the zone", () => {
  // Two sources would drift, and the zone value is the one that matters.
  const keys = securityHeaders(IMAGE_ORIGIN).map((header) => header.key.toLowerCase());
  assert.equal(
    keys.includes("strict-transport-security"),
    false,
    "HSTS belongs to the Cloudflare zone only; adding it here creates a second value",
  );
});

test("an unset image base still yields a parseable policy", () => {
  const bare = contentSecurityPolicy(undefined);
  assert.match(directiveOf(bare, "img-src"), /^img-src 'self' data: blob:$/);
  assert.ok(!bare.includes("undefined"), "an unset origin left the word undefined in the header");
  for (const entry of bare.split("; ")) assert.ok(entry.trim().length > 0);
});

test("originOf accepts a full base URL and rejects what it cannot parse", () => {
  assert.equal(originOf("https://images.nessebarlens.com"), "https://images.nessebarlens.com");
  assert.equal(originOf("https://images.nessebarlens.com/gallery/"), "https://images.nessebarlens.com");
  assert.equal(originOf(undefined), undefined);
  assert.equal(originOf(""), undefined);
  assert.equal(originOf("   "), undefined);
  assert.equal(originOf("images.nessebarlens.com"), undefined, "a bare host is not a URL");
});

test("the dev policy differs from the production one by 'unsafe-eval' and nothing else", () => {
  // The Playwright suite runs `next dev`, so this is the policy those specs
  // actually exercise. It must be the production policy — every origin, every
  // directive — plus the one token React's development build needs. Anything
  // else relaxed here would be relaxed in what ships.
  const prod = contentSecurityPolicy(IMAGE_ORIGIN);
  const dev = contentSecurityPolicy(IMAGE_ORIGIN, { allowEval: true });

  assert.doesNotMatch(prod, /unsafe-eval/, "the shipped policy must not allow eval");
  assert.match(directiveOf(dev, "script-src"), /'unsafe-eval'/);

  assert.equal(
    dev.replace("'unsafe-eval' ", ""),
    prod,
    "the dev policy must differ from production by the unsafe-eval token alone",
  );

  const directivesOf = (policy: string) =>
    policy.split("; ").map((entry) => entry.split(" ")[0]?.trim()).sort();
  assert.deepEqual(directivesOf(dev), directivesOf(prod), "the dev policy lost a directive");
});

test("next.config.ts scopes the eval relaxation to the dev server", () => {
  const config = fs.readFileSync(
    path.join(import.meta.dirname, "..", "next.config.ts"),
    "utf8",
  );
  assert.match(
    config,
    /allowEval: process\.env\.NODE_ENV === "development"/,
    "the eval token must be gated on NODE_ENV, not always on",
  );
});

test("the four headers go on every route, once each", () => {
  const headers = securityHeaders(IMAGE_ORIGIN);
  assert.deepEqual(
    headers.map((header) => header.key),
    ["X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Content-Security-Policy"],
  );
  assert.equal(
    new Set(headers.map((header) => header.key.toLowerCase())).size,
    headers.length,
    "a repeated header key means one value silently wins",
  );

  const value = (key: string) => headers.find((header) => header.key === key)?.value;
  assert.equal(value("X-Frame-Options"), "DENY");
  assert.equal(value("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(value("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(value("Content-Security-Policy"), CSP);
});

test("next.config.ts applies them sitewide and keeps the paid page's overrides last", () => {
  const config = fs.readFileSync(
    path.join(import.meta.dirname, "..", "next.config.ts"),
    "utf8",
  );

  assert.match(config, /source: "\/:path\*"/, "no sitewide rule, so no HTML response carries the policy");
  assert.match(config, /securityHeaders\(IMAGE_ORIGIN, CSP_OPTIONS\)/, "the rule does not use the tested helper");
  assert.match(
    config,
    /originOf\(process\.env\.NEXT_PUBLIC_WEB_IMAGES_BASE\)/,
    "the image origin must come from the same variable the gallery ladder uses",
  );

  // Next resolves overlapping keys last-wins, so /checkout/success's no-referrer
  // has to come after the wildcard or it is downgraded to the site-wide policy
  // on the one page that carries a Stripe session id and a download token.
  const wildcard = config.indexOf('source: "/:path*"');
  const success = config.indexOf('source: "/checkout/success"');
  assert.ok(wildcard > -1 && success > wildcard, "the /checkout/success override must come after the wildcard");
});

/** A `directive` that takes the whole policy, for the fallback-policy case. */
function directiveOf(policy: string, name: string): string {
  const found = policy
    .split("; ")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  assert.ok(found, `the policy has no ${name} directive:\n${policy}`);
  return found;
}
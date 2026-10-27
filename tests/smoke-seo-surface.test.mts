/**
 * The SEO surface assertions in `scripts/smoke.sh` must be able to fail.
 *
 * #436 and #437 shipped a build whose `/llms.txt` was a static file naming the
 * production origin, and `assert-artifact-origin.sh` refused to deploy it — but
 * only after fourteen hours and three failed releases, because the smoke test
 * fetched seven pages and four API paths and none of them was a route the SEO
 * work added. Every check in this file is about the assertions that closed that
 * gap, and every one of them is exercised here against a stub origin carrying
 * the defect it exists to catch.
 *
 * The direction that matters is the failing one. A guard that has only been seen
 * to pass is indistinguishable from a guard that cannot fail, so each mutation
 * here asserts the smoke exits non-zero *and* names the check that caught it —
 * a stub that broke something else would fail these tests rather than pass them
 * quietly. The healthy stub is the control: if it does not exit 0, the harness
 * is wrong and every failure below would be meaningless.
 *
 * The stub is in-process and the script is spawned asynchronously on purpose,
 * for the reason `required-checks-ref.test.mts` gives: `spawnSync` would block
 * the event loop that has to answer the child's requests and the test would look
 * like a hang.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const SCRIPT = new URL("../scripts/smoke.sh", import.meta.url);

/** The origin the stub claims to be, distinct from the one it is reached on. */
const OTHER_ORIGIN = "https://the-other-environment.example";

/**
 * The two hosts in `wrangler.toml`, spelled out rather than parsed, because the
 * tests below need to talk about the real production/staging relationship and
 * `the-other-environment.example` shares none of it. `smoke.sh`'s fallback
 * derivation is pinned to `wrangler.toml` by its own test, so a rename there
 * fails there rather than silently turning these into a weaker case.
 */
const PROD = "https://nessebarlens.com";
const STAGING = "https://staging.nessebarlens.com";

/** A CSP with every directive the real one carries. Trimmed per mutation. */
const FULL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com " +
    "https://static.cloudflareinsights.com",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The one defect a case injects. Absent means the stub is healthy, which is the
 * control every failing case is read against.
 */
type Defect =
  /** Paths that 404, as a build that lost the route would. */
  | "route-missing"
  | "sitemap-missing"
  | "robots-missing"
  /** Both generated files naming the other environment's origin. */
  | "wrong-origin"
  /** A route answering 200 with the wrong content type. */
  | "llms-as-html"
  | "sitemap-as-text"
  /** robots.txt with no pointer to the sitemap. */
  | "no-sitemap-line"
  /** #434's beacon absent, though every page still renders. */
  | "no-beacon"
  /**
   * Cloudflare's automatic injection, for a browser-like agent only: a second
   * beacon carrying the token. The collision drops `send.to` and sends nothing.
   */
  | "injected-beacon"
  /**
   * An injector that writes only a script tag. The count assertion cannot see
   * it — there is still exactly one `data-cf-beacon` — so the script-tag
   * assertion is the only thing standing between this and a silent zero.
   */
  | "injected-script-only"
  /**
   * An injector that rewrites the payload instead of adding a script tag: a
   * second `afterInteractive` entry and no `<script>` element. Nothing but the
   * count can see this, which is why the two assertions are separate tests
   * rather than one convenient count.
   */
  | "injected-payload"
  /** No CSP header at all. */
  | "no-csp"
  /** The RUM origin in `script-src` only — the mistake security-headers.ts documents. */
  | "rum-in-script-src"
  /**
   * The legacy URL answers 200 instead of redirecting. The pages still render
   * and the new URLs still work, so nothing else in the smoke notices: the
   * redirect is the only thing that is gone, and a check that asked only for
   * the new page would not see it.
   */
  | "redirect-missing"
  /**
   * The legacy URL redirects, but to the wrong place. A 308 with a bad
   * `Location` sends the visitor somewhere they did not ask for, and no status
   * code in the smoke shows it.
   */
  | "redirect-wrong-target";

const DEFECT_LABEL: Record<Defect, string> = {
  "route-missing": "GET /llms.txt names this origin",
  "sitemap-missing": "GET /sitemap.xml names this origin",
  "robots-missing": "GET /robots.txt points at the sitemap",
  "wrong-origin": "GET /llms.txt omits the other origin",
  "llms-as-html": "GET /llms.txt content type",
  "sitemap-as-text": "GET /sitemap.xml content type",
  "no-sitemap-line": "GET /robots.txt points at the sitemap",
  "no-beacon": "GET /en serves exactly one Web Analytics beacon",
  "injected-beacon": "GET /en serves exactly one Web Analytics beacon",
  "injected-script-only": "GET /en serves exactly one Web Analytics beacon",
  "injected-payload": "GET /en serves exactly one Web Analytics beacon",
  "no-csp": "GET /en CSP allows the beacon to report",
  "rum-in-script-src": "GET /en CSP allows the beacon to report",
  "redirect-missing": "GET / redirects to /en",
  "redirect-wrong-target": "GET / redirects to /en",
};

/**
 * How Next actually serves an `afterInteractive` script: a preload link and an
 * RSC payload entry for the same src, and **no literal `<script>` tag**, because
 * the element is created at runtime. Matched against production HTML — a stub
 * that writes a script tag would make the injection assertion unfalsifiable,
 * since every healthy build would already look injected.
 */
const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
const BEACON_PRELOAD = `<link rel="preload" href="${BEACON_SRC}" as="script"/>`;
// Only three things in this payload matter to the smoke: the src, the
// `data-cf-beacon` attribute name, and the pinned endpoint. Its JSON shape does
// not, so it is not reproduced — the assertions read names and hosts.
const BEACON_PAYLOAD =
  `"src":"${BEACON_SRC}","strategy":"afterInteractive",` +
  '"data-cf-beacon":"token=stub;to=https://cloudflareinsights.com/cdn-cgi/rum"';

/** What edge injection adds: a real script tag, versioned, deferred. */
const INJECTED_WITH_ATTR =
  `<script defer src='${BEACON_SRC}?v=1-0-0' data-cf-beacon='{"token":"stub"}'></script>`;
const INJECTED_BARE = `<script defer src='${BEACON_SRC}?v=1-0-0'></script>`;

/**
 * Cloudflare injects only for browser-like agents, which is the whole reason the
 * beacon checks carry a browser UA. Modelled here so a case that depended on
 * the smoke sending one would pass against a plain-curl stub and fail in
 * production.
 */
function isBrowserLike(userAgent: string | string[] | undefined): boolean {
  const ua = Array.isArray(userAgent) ? userAgent.join(" ") : userAgent;
  return /Mozilla|AppleWebKit|Chrome/.test(ua ?? "");
}

function cspFor(defect: Defect | undefined): string | undefined {
  if (defect === "no-csp") return undefined;
  if (defect === "rum-in-script-src") {
    // The beacon loads from static.cloudflareinsights.com and reports to
    // cloudflareinsights.com. Naming only the script host in connect-src blocks
    // every pageview at runtime, and no status code in the smoke would show it.
    return FULL_CSP.replace(
      "connect-src 'self' https://cloudflareinsights.com",
      "connect-src 'self'",
    ).replace(
      "https://static.cloudflareinsights.com",
      "https://static.cloudflareinsights.com https://cloudflareinsights.com",
    );
  }
  return FULL_CSP;
}

/**
 * The locale-prefixed path a legacy URL redirects to, or undefined when the
 * path is not a legacy one.
 *
 * Every public page moved under a locale segment, so the URLs that existed
 * before the move are permanent redirects to their `/en/...` equivalent. The
 * smoke asserts both halves — the 308 and the page it points at — so the stub
 * has to serve both, or the assertions would be unfalsifiable.
 */
function legacyTargetFor(path: string, defect: Defect | undefined): string | undefined {
  if (defect === "redirect-missing") return undefined;
  if (defect === "redirect-wrong-target") return "/en/somewhere-else";
  if (path === "/") return "/en";
  if (
    ["/fine-art", "/archive", "/film", "/story", "/contact"].includes(path) ||
    path.startsWith("/prints/")
  ) {
    return `/en${path}`;
  }
  return undefined;
}

async function withStub(
  defect: Defect | undefined,
  body: (baseUrl: string) => Promise<void>,
  /**
   * The origin the stub's generated files name. Undefined means "whatever host
   * the request arrived on", which is the healthy case for a caller that points
   * the smoke at the origin it expects. Set it to emulate a build made for one
   * environment and served from another — the preview version URL, and what a
   * per-environment build gets wrong.
   */
  servedOrigin?: string,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;

    const send = (
      status: number,
      payload: string,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        ...headers,
      });
      res.end(payload);
    };

    const csp = cspFor(defect);
    const withCsp = <T extends Record<string, string>>(headers: T) =>
      csp ? { ...headers, "Content-Security-Policy": csp } : headers;

    if (
      (defect === "route-missing" && path === "/llms.txt") ||
      (defect === "sitemap-missing" && path === "/sitemap.xml") ||
      (defect === "robots-missing" && path === "/robots.txt")
    ) {
      return send(404, "not found", withCsp({ "content-type": "text/plain" }));
    }

    // The generated files name the origin the build was made for, which is what
    // a per-environment build gets right and a copied artifact gets wrong.
    const origin = servedOrigin ?? baseOrigin(req) ?? "";
    const canonical = defect === "wrong-origin" ? OTHER_ORIGIN : origin;

    // The legacy English URLs answer 308 and point at their locale-prefixed
    // equivalent. A redirect that answers 308 and points at the wrong place is
    // as broken as one that answers 404, so the target is asserted too.
    const legacyTarget = legacyTargetFor(path, defect);
    if (legacyTarget !== undefined) {
      return send(308, "moved", withCsp({ location: `${origin}${legacyTarget}` }));
    }

    // A locale the site knows but does not serve is a 404, never an English
    // page wearing a foreign URL.
    if (path === "/bg") {
      return send(404, "not found", withCsp({ "content-type": "text/plain" }));
    }

    if (path === "/llms.txt") {
      const body = `# Nessebar Lens\n\n${canonical}/sitemap.xml\n\n- [Home](${canonical}/): entry point.\n`;
      return send(
        200,
        body,
        withCsp({
          "content-type":
            defect === "llms-as-html" ? "text/html" : "text/plain; charset=utf-8",
        }),
      );
    }

    if (path === "/sitemap.xml") {
      const body = `<?xml version="1.0"?><urlset><url><loc>${canonical}/</loc></url></urlset>`;
      return send(
        200,
        body,
        withCsp({
          "content-type":
            defect === "sitemap-as-text" ? "text/plain" : "application/xml",
        }),
      );
    }

    if (path === "/robots.txt") {
      const body =
        defect === "no-sitemap-line"
          ? "User-agent: *\nAllow: /\n"
          : `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
      return send(200, body, withCsp({ "content-type": "text/plain" }));
    }

    // The pre-existing checks, so a mutation below cannot fail them by accident
    // and make the defect's own assertion unfalsifiable.
    if (path === "/api/download") {
      const token = url.searchParams.get("token") ?? "";
      return token === "not-a-token"
        ? send(400, "invalid-token", withCsp({ "content-type": "text/plain" }))
        : send(404, "unknown", withCsp({ "content-type": "text/plain" }));
    }
    if (path === "/api/print-asset") {
      return send(400, "invalid-exp", withCsp({ "content-type": "text/plain" }));
    }
    if (path === "/en/prints/zzz-not-a-real-photo-slug") {
      return send(404, "no such print", withCsp({ "content-type": "text/plain" }));
    }
    if (req.method === "POST" && path === "/api/quote") {
      return send(400, "format must be one of", withCsp({ "content-type": "text/plain" }));
    }

    // Injection is browser-only, so a stub reached by curl stays healthy and the
    // smoke has to ask as a browser to see it at all.
    const browser = isBrowserLike(req.headers["user-agent"]);
    const injected =
      browser && defect === "injected-beacon"
        ? INJECTED_WITH_ATTR
        : browser && defect === "injected-script-only"
          ? INJECTED_BARE
          : browser && defect === "injected-payload"
            ? BEACON_PAYLOAD
            : "";
    const beacons = defect === "no-beacon" ? "" : BEACON_PRELOAD + BEACON_PAYLOAD + injected;
    return send(200, `<!doctype html><html><body>${beacons}</body></html>`, withCsp({}));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** The origin the stub was reached on, so its answers name the caller's host. */
function baseOrigin(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const host = req.headers.host;
  return typeof host === "string" ? `http://${host}` : undefined;
}

type RunOptions = {
  /** Defaults to the base URL, which is what ci.yml and release.yml get. */
  expected?: string;
  /** Defaults to `OTHER_ORIGIN`. `null` leaves the variable unset. */
  forbidden?: string | null;
};

function run(baseUrl: string, options: RunOptions = {}): Promise<{ code: number | null; out: string }> {
  const { expected = baseUrl, forbidden = OTHER_ORIGIN } = options;
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // One attempt, no sleep: every case here is a deterministic server, so
      // a retry would only hide a broken stub behind a passing exit code.
      SMOKE_ATTEMPTS: "1",
      SMOKE_SLEEP: "0",
      // What preview.yml passes, and what a local or release caller gets for
      // free: the origin the build should be asserting, which is not the URL
      // the smoke happens to be pointed at.
      SMOKE_EXPECTED_ORIGIN: expected,
    };
    if (forbidden !== null) env.SMOKE_FORBIDDEN_ORIGIN = forbidden;
    else delete env.SMOKE_FORBIDDEN_ORIGIN;

    const child = spawn("bash", [SCRIPT.pathname, baseUrl], { env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`smoke.sh did not exit within 60s; output so far:\n${out}`));
    }, 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(guard);
      resolve({ code, out });
    });
  });
}

test("the healthy stub passes, so a failure below is the defect and not the harness", async () => {
  // A deployed origin, not the stub's localhost: a local build renders no
  // beacon and skips those checks, and this case exists to prove the harness
  // runs the full battery rather than to re-test the skip.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { expected: PROD, forbidden: OTHER_ORIGIN });
    assert.equal(code, 0, `the stub is meant to be healthy:\n${out}`);
    // The cross-origin check only runs when the two hosts are known, so passing
    // SMOKE_FORBIDDEN_ORIGIN has to actually reach it rather than be skipped.
    assert.doesNotMatch(out, /^smoke: SKIP/m);
    assert.match(out, /smoke: \d+ passed, 0 failed/);
  }, PROD);
});

const DEFECTS = Object.keys(DEFECT_LABEL) as Defect[];

for (const defect of DEFECTS) {
  test(`smoke.sh fails when the build has: ${defect}`, async () => {
    await withStub(defect, async (baseUrl) => {
      const { code, out } = await run(baseUrl, { expected: PROD, forbidden: OTHER_ORIGIN });
      const label = DEFECT_LABEL[defect];

      assert.notEqual(
        code,
        0,
        `${defect} must fail the smoke, or it is not being detected:\n${out}`,
      );
      const failed = out
        .split("\n")
        .filter((line) => line.startsWith("smoke: FAIL"));
      assert.ok(
        failed.some((line) => line.includes(label)),
        `expected the failure to name "${label}", got:\n${failed.join("\n") || out}`,
      );
    }, PROD);
  });
}

test("a local origin skips the beacon checks rather than demanding the flood back", async () => {
  // #443: a build configured for localhost renders no beacon, because dev and
  // test runs were recording ~1,200 pageviews/day in production Web Analytics.
  // The CI Worker battery is exactly that build, so it must skip these two
  // checks and still pass everything else.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { forbidden: null });
    assert.equal(code, 0, out);
    assert.match(out, /^smoke: SKIP {2}beacon checks \(local origin /m);
    assert.doesNotMatch(out, /^smoke: FAIL/m);
  });
});

test("an origin with no counterpart skips the cross-origin check rather than inventing one", async () => {
  // A preview version URL has no alias and no "other environment" to be wrong
  // about. Asserting something for it would be asserting nothing, so the check
  // reports itself as skipped instead of passing silently.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { forbidden: null });
    assert.equal(code, 0, out);
    assert.match(out, /^smoke: SKIP {2}\/llms\.txt cross-origin check/m);
  });
});

test("a set-but-empty SMOKE_EXPECTED_ORIGIN is an error, not a silent fallback", async () => {
  // On a preview the two spellings differ, so falling back to the base URL would
  // assert the version URL is canonical when the build never carried it — a
  // guard that passes on the wrong premise. Set-but-empty is what a missing
  // NEXT_PUBLIC_SITE_URL secret looks like.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { expected: "", forbidden: null });
    assert.equal(code, 1, out);
    assert.match(out, /SMOKE_EXPECTED_ORIGIN is set but empty/);
  });
});

// The forbidden-origin match has one job that a bare substring search cannot do.
// `staging.nessebarlens.com` contains `nessebarlens.com`, so matching the domain
// without a host boundary fails every correct staging build and — once someone
// "fixes" that by dropping the check — leaves production unchecked. Both
// directions are pinned, because each one alone is satisfiable by a matcher that
// never fires.

test("a staging build passes a production-forbidden assertion", async () => {
  // The false-fail. Every URL in this body is correct, and each one contains the
  // forbidden host as a substring.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { expected: STAGING, forbidden: PROD });
    assert.equal(
      code,
      0,
      `a staging build must not fail because its own host contains the production domain:\n${out}`,
    );
    assert.match(
      out,
      /smoke: PASS {2}GET \/llms\.txt omits the other origin body omits the host "nessebarlens\.com"/,
    );
  }, STAGING);
});

test("a production build serving staging origin fails, and quotes the offending line", async () => {
  // The false-pass, and the failure message: a verdict with no match in it costs
  // another archaeology session, and the body is prose from here down.
  await withStub(undefined, async (baseUrl) => {
    const { code, out } = await run(baseUrl, { expected: PROD, forbidden: STAGING });
    assert.notEqual(code, 0, `a production site on staging URLs must fail:\n${out}`);

    const failed = out
      .split("\n")
      .filter((line) => line.startsWith("smoke: FAIL"));
    assert.ok(
      failed.some((line) => line.includes("GET /llms.txt omits the other origin")),
      `expected the cross-origin check to fail, got:\n${failed.join("\n") || out}`,
    );
    assert.match(
      failed.find((line) => line.includes("omits the other origin"))!,
      /staging\.nessebarlens\.com/,
      `the failure line must name the host it found:\n${failed.join("\n")}`,
    );
    // The quoted line, indented under the verdict rather than left to be found.
    assert.match(
      out,
      /^smoke: {8}.*staging\.nessebarlens\.com/m,
      `the offending line must be printed:\n${out}`,
    );
  }, STAGING);
});

test("the cross-origin fallback covers both hosts in wrangler.toml", async () => {
  // preview.yml passes SMOKE_EXPECTED_ORIGIN and nothing else, so the
  // cross-origin check there runs entirely off this derivation. `the-other-
  // environment.example` shares no structure with the real hosts and cannot
  // stand in for it: the whole point is that one of them is a subdomain of the
  // other.
  const wrangler = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const configured = [...wrangler.matchAll(/^NEXT_PUBLIC_SITE_URL\s*=\s*"([^"]+)"/gm)].map(
    ([, origin]) => origin,
  );
  assert.deepEqual(
    [...new Set(configured)].sort(),
    [PROD, STAGING],
    "wrangler.toml no longer declares exactly the two hosts these cases are written against",
  );

  for (const [expected, forbidden] of [
    [PROD, STAGING],
    [STAGING, PROD],
  ] as const) {
    await withStub(undefined, async (baseUrl) => {
      const { code, out } = await run(baseUrl, { expected, forbidden: null });
      assert.equal(code, 0, out);
      assert.match(out, new RegExp(`^smoke: canonical=${expected} forbidden=${forbidden}$`, "m"));
      assert.doesNotMatch(
        out,
        /^smoke: SKIP/m,
        `a preview built for ${expected} must still get the cross-origin check`,
      );
    }, expected);
  }
});
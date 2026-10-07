/**
 * src/lib/config.ts — the one place environment is read (#119).
 *
 * Most of this module's behaviour is already pinned where its consumers are
 * (print-asset's min-length rule, the site-url fallback, the Prodigi
 * allowlist). What is tested here is the module's own surface, because it is
 * the module the AST guard trusts: if getConfig is wrong, every reader is wrong
 * in the same way at once and no per-feature test would notice.
 *
 * The two things worth stating rather than merely executing:
 *
 *   - getConfig never throws, including when Prodigi is entirely absent. That is
 *     the 503-vs-502 invariant: an eager config read above a route's failure
 *     mapping would turn "this deploy is misconfigured" into "Prodigi is
 *     unhealthy" and send an operator to the wrong status page.
 *   - the report is a list and the message is a string, so a route can answer
 *     503 with a body and a deploy check can print one line.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredSiteUrl,
  getConfig,
  isConfiguredSiteUrl,
  isProduction,
  missingProductionConfig,
  printAssetSecret,
  PRINT_ASSET_SECRET_MIN_LENGTH,
  prodigiConfig,
  siteUrl,
  stripeSecretKey,
  usablePrintAssetSecret,
  webImagesBase,
} from "../src/lib/config.ts";

const SANDBOX = "https://api.sandbox.prodigi.com";
const LIVE = "https://api.prodigi.com";
const SECRET = "test-print-asset-hmac-secret-32b-min!!";

/**
 * Every variable this module reads. A test that passes `{}` to a reader is not
 * asserting "unset" — envString layers the argument over process.env, so on a
 * deployment that has these set, `{}` reads the real environment and the
 * assertion is a lie. Anything asserting absence deletes them first. This is
 * the same trap #119 removed from prodigi-config.ts, in the tests instead.
 */
const ALL_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "NODE_ENV",
  "STRIPE_SECRET_KEY",
  "PRODIGI_API_BASE",
  "PRODIGI_API_KEY",
  "PRODIGI_SANDBOX_API_KEY",
  "PRINT_ASSET_HMAC_SECRET",
  "NEXT_PUBLIC_WEB_IMAGES_BASE",
] as const;

/** Nothing in the ambient environment: what "unconfigured" actually means. */
function withCleanEnv<T>(body: () => T): T {
  return withEnv(
    Object.fromEntries(ALL_KEYS.map((key) => [key, undefined])),
    body,
  );
}

/** With process.env mutated only for keys the caller names. */
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  body: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a fully configured deployment reports nothing missing", () => withCleanEnv(() => {
  const env = {
    NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com/",
    STRIPE_SECRET_KEY: "sk_test_x",
    PRODIGI_API_BASE: SANDBOX,
    PRODIGI_SANDBOX_API_KEY: "sandbox-key",
    PRINT_ASSET_HMAC_SECRET: SECRET,
  };
  assert.deepEqual(missingProductionConfig(env), []);

  const config = getConfig(env);
  assert.deepEqual(config, {
    // One trailing slash dropped; callers concatenate paths onto this.
    siteUrl: "https://nessebarlens.com",
    stripe: { secretKey: "sk_test_x" },
    prodigi: { apiBase: SANDBOX, keyConfigured: true },
    printAsset: { secret: SECRET },
    // Download-token policy has defaults rather than being required (#111): a
    // deployment with none of these set still gets the documented 30 days / 5
    // downloads, so an unset var can never mean "unlimited".
    download: { tokenTtlSeconds: 30 * 86_400, maxDownloads: 5 },
  });
}));

test("an empty deployment names every missing value, in a stable order", () =>
  withCleanEnv(() => {
  assert.deepEqual(missingProductionConfig({}), [
    "NEXT_PUBLIC_SITE_URL",
    "STRIPE_SECRET_KEY",
    "PRODIGI_API_BASE",
    "PRODIGI_API_KEY",
    "PRINT_ASSET_HMAC_SECRET",
  ]);
}));

test("a half-configured deployment names only what is actually absent", () => withCleanEnv(() => {
  const env = {
    NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com",
    STRIPE_SECRET_KEY: "sk_test_x",
    PRODIGI_API_BASE: SANDBOX,
    PRODIGI_SANDBOX_API_KEY: "sandbox-key",
  };
  assert.deepEqual(missingProductionConfig(env), ["PRINT_ASSET_HMAC_SECRET"]);
}));

test("getConfig does not throw when Prodigi is unconfigured", () => {
  // The whole reason the summary carries keyConfigured rather than a key: this
  // runs above a route's failure mapping, so a throw here would pre-empt
  // prodigiFailureFrom() and report our misconfiguration as a Prodigi outage.
  withCleanEnv(() => {
    const config = getConfig({});
    assert.deepEqual(config.prodigi, { apiBase: undefined, keyConfigured: false });
    assert.equal(config.printAsset.secret, null);
  });
});

test("a sandbox host paired with the live key is not configured", () => {
  assert.equal(
    getConfig({ PRODIGI_API_BASE: SANDBOX, PRODIGI_API_KEY: "live-key" }).prodigi
      .keyConfigured,
    false,
  );
  assert.equal(
    getConfig({ PRODIGI_API_BASE: LIVE, PRODIGI_API_KEY: "live-key" }).prodigi
      .keyConfigured,
    true,
  );
});

test("a base that is not allowlisted is absent from the summary", () => {
  // Unset *and* not-allowlisted are the same thing to the summary, because both
  // are "this deployment is misconfigured". Reporting the wrong host as present
  // would mean the one-clear-error path never names it and the operator only
  // finds out on the first request.
  const config = getConfig({ PRODIGI_API_BASE: "https://evil.example" });
  assert.deepEqual(config.prodigi, { apiBase: undefined, keyConfigured: false });
  withCleanEnv(() =>
    assert.deepEqual(
      missingProductionConfig({ PRODIGI_API_BASE: "https://evil.example" }),
      [
        "NEXT_PUBLIC_SITE_URL",
        "STRIPE_SECRET_KEY",
        "PRODIGI_API_BASE",
        "PRODIGI_API_KEY",
        "PRINT_ASSET_HMAC_SECRET",
      ],
    ),
  );
  // Still reported before any money moves, and by the reader that owns the
  // message: the summary delegates to the same allowlist.
  assert.equal(
    prodigiConfig({ PRODIGI_API_BASE: "https://evil.example" }).ok,
    false,
  );
  assert.equal(
    getConfig({ PRODIGI_API_BASE: SANDBOX }).prodigi.apiBase,
    SANDBOX,
  );
});

test("the Prodigi config read reads through config, message and all", () => {
  // prodigiConfig is the wrapper prodigi-quote/order/cancel call, so the host/
  // key pair and the unconfigured message have to arrive here byte-identical
  // to what prodigi-config produces.
  withEnv({ PRODIGI_API_BASE: SANDBOX, PRODIGI_SANDBOX_API_KEY: "sandbox-key" }, () => {
    assert.deepEqual(prodigiConfig(), {
      ok: true,
      base: SANDBOX,
      key: "sandbox-key",
    });
    // …and they honour an explicit env, so the Worker env still wins.
    assert.deepEqual(
      prodigiConfig({ PRODIGI_API_BASE: LIVE, PRODIGI_API_KEY: "live" }),
      { ok: true, base: LIVE, key: "live" },
    );
  });
  withEnv({ PRODIGI_API_BASE: undefined, PRODIGI_API_KEY: undefined }, () => {
    const unconfigured = prodigiConfig();
    assert.equal(unconfigured.ok, false);
    assert.equal(unconfigured.kind, "unconfigured");
    assert.match(unconfigured.message, /PRODIGI_API_BASE must be/);
  });
});

test("siteUrl falls back to localhost only outside production", () => withCleanEnv(() => {
  assert.equal(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://a.example" }), "https://a.example");
  assert.equal(siteUrl({}), "http://localhost:3000");
  assert.equal(siteUrl({ NEXT_PUBLIC_SITE_URL: "  " }), "http://localhost:3000");
  assert.throws(
    () => siteUrl({ NODE_ENV: "production" }),
    /NEXT_PUBLIC_SITE_URL is not set/,
  );
  // A padded NODE_ENV counts, like every other reader.
  assert.throws(
    () => siteUrl({ NODE_ENV: "production " }),
    /NEXT_PUBLIC_SITE_URL is not set/,
  );
  assert.equal(isProduction({ NODE_ENV: "production" }), true);
  assert.equal(isProduction({}), false);
}));

test("configuredSiteUrl and isConfiguredSiteUrl answer before the fallback", () => withCleanEnv(() => {
  // A route must be able to decide "not configured" without building a Stripe
  // session it is going to discard, and without the localhost fallback hiding
  // the absence.
  assert.equal(configuredSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://a.example/" }), "https://a.example");
  assert.equal(configuredSiteUrl({ NEXT_PUBLIC_SITE_URL: "/" }), undefined);
  assert.equal(isConfiguredSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://a.example" }), true);
  assert.equal(configuredSiteUrl({}), undefined);
  assert.equal(isConfiguredSiteUrl({}), false);
}));

test("the readers default to the deployment's own environment", () => {
  // The default-argument paths, which is where process.env is read. Asserted
  // against the real environment rather than a stub so the default is
  // exercised, not just the signature.
  withEnv({ NEXT_PUBLIC_SITE_URL: "https://a.example" }, () => {
    assert.equal(configuredSiteUrl(), "https://a.example");
    assert.equal(siteUrl(), "https://a.example");
    assert.equal(isConfiguredSiteUrl(), true);
  });
  withEnv({ STRIPE_SECRET_KEY: "sk_live_x" }, () => {
    assert.equal(stripeSecretKey(), "sk_live_x");
  });
  withEnv({ PRINT_ASSET_HMAC_SECRET: SECRET }, () => {
    assert.equal(printAssetSecret(), SECRET);
  });
  withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(isProduction(), true);
  });
  withEnv({ NEXT_PUBLIC_WEB_IMAGES_BASE: "https://cdn.example/bucket" }, () => {
    assert.equal(webImagesBase(), "https://cdn.example/bucket");
  });
  withEnv({ PRINT_ASSET_HMAC_SECRET: undefined, NEXT_PUBLIC_SITE_URL: undefined }, () => {
    assert.equal(missingProductionConfig().includes("NEXT_PUBLIC_SITE_URL"), true);
  });
});

test("webImagesBase is https-only and never carries a trailing slash", () => withCleanEnv(() => {
  assert.equal(webImagesBase({ NEXT_PUBLIC_WEB_IMAGES_BASE: "https://cdn.example/b/" }), "https://cdn.example/b");
  assert.equal(webImagesBase({ NEXT_PUBLIC_WEB_IMAGES_BASE: "http://cdn.example" }), undefined);
  assert.equal(webImagesBase({ NEXT_PUBLIC_WEB_IMAGES_BASE: "not a url" }), undefined);
  assert.equal(webImagesBase({ NEXT_PUBLIC_WEB_IMAGES_BASE: "   " }), undefined);
  assert.equal(webImagesBase({}), undefined);
}));

test("usablePrintAssetSecret rejects whitespace and short keys, and trims", () => withCleanEnv(() => {
  assert.equal(usablePrintAssetSecret(SECRET), SECRET);
  assert.equal(usablePrintAssetSecret(`  ${SECRET}  `), SECRET);
  assert.equal(usablePrintAssetSecret("x".repeat(PRINT_ASSET_SECRET_MIN_LENGTH - 1)), null);
  assert.equal(usablePrintAssetSecret("   "), null);
  assert.equal(usablePrintAssetSecret(null), null);
  assert.equal(usablePrintAssetSecret(undefined), null);
  assert.equal(
    usablePrintAssetSecret("x".repeat(PRINT_ASSET_SECRET_MIN_LENGTH)).length,
    PRINT_ASSET_SECRET_MIN_LENGTH,
  );
  assert.equal(
    printAssetSecret({ PRINT_ASSET_HMAC_SECRET: ` ${SECRET} ` }),
    SECRET,
  );
  assert.equal(printAssetSecret({ PRINT_ASSET_HMAC_SECRET: "short" }), null);
  assert.equal(printAssetSecret({}), null);
}));
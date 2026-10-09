import assert from "node:assert/strict";
import test from "node:test";
import { getStripe } from "../src/infrastructure/stripe/stripe.ts";
import { isConfiguredSiteUrl, siteUrl } from "../src/infrastructure/config/config.ts";
import { signPrintAssetUrl } from "../src/application/fulfillment/print-asset.ts";
import { ConfiguredAssetUrlSigner } from "../src/infrastructure/print-asset/asset-url-signer.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

const SIGNER = new ConfiguredAssetUrlSigner();

/**
 * Sets NEXT_PUBLIC_SITE_URL for the body, with NODE_ENV cleared.
 *
 * siteUrl() throws when NODE_ENV says production, so this has to own both keys:
 * a test asserting the localhost fallback is asserting "not production", and
 * leaving that to whatever the runner exports makes the assertion environment-
 * dependent — a CI runner with NODE_ENV=production fails a test about dev.
 */
async function withSiteUrl<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = value;
    delete process.env.NODE_ENV;
    return await fn();
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

test("siteUrl never returns a trailing slash", async () => {
  for (const raw of [
    "https://nessebarlens.com",
    "https://nessebarlens.com/",
    "https://nessebarlens.com///",
    "  https://nessebarlens.com/  ",
  ]) {
    await withSiteUrl(raw, () => {
      assert.equal(siteUrl(), "https://nessebarlens.com", raw);
      assert.ok(!siteUrl().endsWith("/"), raw);
    });
  }
});

test("siteUrl falls back to localhost when unset or blank", async () => {
  for (const raw of [undefined, "", "   "]) {
    await withSiteUrl(raw, () => {
      assert.equal(siteUrl(), "http://localhost:3000");
    });
  }
});

test("siteUrl throws in production instead of returning localhost", async () => {
  for (const raw of [undefined, "", "   "]) {
    await withSiteUrl(raw, () => {
      const savedEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        assert.throws(() => siteUrl(), /NEXT_PUBLIC_SITE_URL is not set/);
        // Never a localhost URL, whatever the caller does with the throw.
        assert.equal(isConfiguredSiteUrl(), false);
      } finally {
        if (savedEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedEnv;
      }
    });
  }
});

test("isConfiguredSiteUrl follows the stripped value, in any environment", async () => {
  const savedEnv = process.env.NODE_ENV;
  try {
    for (const raw of ["https://nessebarlens.com", "https://nessebarlens.com/"]) {
      process.env.NODE_ENV = "production";
      await withSiteUrl(raw, () => {
        assert.equal(isConfiguredSiteUrl(), true, raw);
        assert.equal(siteUrl(), "https://nessebarlens.com", raw);
      });
    }
    process.env.NODE_ENV = "development";
    await withSiteUrl(undefined, () => {
      assert.equal(isConfiguredSiteUrl(), false);
      assert.equal(siteUrl(), "http://localhost:3000");
    });
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  }
});

test("signed print-asset URLs have no double slash at the join", async () => {
  const url = await withSiteUrl("https://nessebarlens.com/", () =>
    signPrintAssetUrl(SAMPLE_SLUG, SIGNER, {
      secret: "test-print-asset-hmac-secret-32b-min!!",
      baseUrl: undefined,
    }),
  );
  assert.ok(url);
  assert.ok(url.startsWith("https://nessebarlens.com/api/print-asset?"), url);
  assert.ok(!url.includes("//api"), url);
});

test("getStripe refuses to build a client without a secret key", async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  try {
    for (const raw of [undefined, "", "   "]) {
      if (raw === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = raw;
      // A blank key must throw, not hand back a client that 401s later.
      assert.throws(() => getStripe(), /STRIPE_SECRET_KEY is not set/);
    }
  } finally {
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
  }
});

test("getStripe builds a client on the fetch http client", async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy_not_used_for_requests";
    const client = getStripe();
    assert.equal(typeof client.checkout.sessions.create, "function");
    assert.equal(typeof client.webhooks.constructEvent, "function");
    // Padded keys are trimmed, not handed to Stripe as-is.
    process.env.STRIPE_SECRET_KEY = "  sk_test_padded  ";
    assert.doesNotThrow(() => getStripe());
  } finally {
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
  }
});

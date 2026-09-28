import assert from "node:assert/strict";
import test from "node:test";
import { siteUrl } from "../src/lib/stripe.ts";
import { signPrintAssetUrl } from "../src/lib/print-asset.ts";

async function withSiteUrl<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = value;
    return await fn();
  } finally {
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

test("signed print-asset URLs have no double slash at the join", async () => {
  const url = await withSiteUrl("https://nessebarlens.com/", () =>
    signPrintAssetUrl("dawn", {
      secret: "test-print-asset-hmac-secret-32b-min!!",
      baseUrl: undefined,
    }),
  );
  assert.ok(url);
  assert.ok(url.startsWith("https://nessebarlens.com/api/print-asset?"), url);
  assert.ok(!url.includes("//api"), url);
});

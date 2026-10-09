import assert from "node:assert/strict";
import test from "node:test";
import {
  createProdigiOrder,
  type OrderRecipient,
} from "../src/infrastructure/prodigi/prodigi-order.ts";
import { verifyPrintAssetRequest } from "../src/application/fulfillment/print-asset.ts";
import { signPrintAssetUrl } from "../src/application/fulfillment/print-asset.ts";
import { parseQuoteBody } from "../src/domain/ordering/checkout-body.ts";
import {
  decideFulfillment,
  type OrderRecord,
} from "../src/domain/ordering/order-decision.ts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";

/* The remaining defensive branches: the paths taken when a value is absent,
   the wrong type, or not an Error at all. Each was unreachable from the tests
   and reachable from production. */

const SECRET = "test-print-asset-hmac-secret-32b-min!!";
const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: null,
  phone: null,
};

test("a secret passed as null is the same as no secret at all", async () => {
  // The route passes options.secret explicitly, so the undefined branch (read
  // from env) is not the one production takes. A Worker binding can hold
  // "   " where an env reader would have produced nothing, and "   " is
  // truthy — without the trim it signed URLs with a whitespace key and every
  // legitimate request came back 401 instead of the 503 that means
  // "unconfigured".
  const signed = await signPrintAssetUrl(SAMPLE_SLUG, { secret: SECRET });
  assert.ok(signed, "a signed URL is available for the rest of this test");
  // searchParams is a live view, not a plain object: destructuring it yields
  // undefined for every key. The first run of this test passed for that reason
  // alone, with exp undefined.
  const params = new URL(signed!).searchParams;
  const exp = params.get("exp")!;
  const sig = params.get("sig")!;
  for (const secret of [null, "", "   "]) {
    const result = await verifyPrintAssetRequest(SAMPLE_SLUG, exp, sig, { secret });
    assert.equal(result.ok, false, JSON.stringify(secret));
    assert.equal(result.status, 503);
    assert.equal(result.error, "print-asset-unavailable");
  }
  // `undefined` is the one that means "read this deployment's secret", so it
  // only proves "unconfigured" when there is none — the env has to be cleared
  // rather than assumed empty, or a runner with the secret exported verifies
  // successfully and this assertion is testing the opposite of what it says.
  {
    const saved = process.env.PRINT_ASSET_HMAC_SECRET;
    try {
      delete process.env.PRINT_ASSET_HMAC_SECRET;
      const result = await verifyPrintAssetRequest(SAMPLE_SLUG, exp, sig, {
        secret: undefined,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.error, "print-asset-unavailable");
    } finally {
      if (saved === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
      else process.env.PRINT_ASSET_HMAC_SECRET = saved;
    }
  }
  // A secret that is only padded still verifies, because it is the same key.
  const padded = await verifyPrintAssetRequest(SAMPLE_SLUG, exp, sig, {
    secret: ` ${SECRET} `,
  });
  assert.equal(padded.ok, true, "a padded secret is the same key once trimmed");
  // And the same URL verifies with the exact secret, so the rejection above is
  // the secret and not the signature.
  const ok = await verifyPrintAssetRequest(SAMPLE_SLUG, exp, sig, { secret: SECRET });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
});

test("expiry is checked against the wall clock when no now is given", async () => {
  // The webhook path injects now for determinism; this branch is the one the
  // route uses. An expiry that is already in the past must fail on the real
  // clock, with no nowMs to lean on.
  const signed = await signPrintAssetUrl(SAMPLE_SLUG, { secret: SECRET });
  const params = new URL(signed!).searchParams;
  const expired = await verifyPrintAssetRequest(
    SAMPLE_SLUG,
    "1000000000",
    params.get("sig")!,
    { secret: SECRET },
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.error, "expired");
});

test("a quote for a framed print needs a frame finish from the list", () => {
  for (const frame of [7, null, "", "gold-ish", []]) {
    const result = parseQuoteBody({ format: "framed", size: "30x40", frame });
    assert.match(
      (result as { error: string }).error,
      /^frame required for framed/,
      JSON.stringify(frame),
    );
  }
  // A frame finish from the list is accepted, so the check is not a blanket
  // rejection of framed quotes.
  assert.equal(
    "format" in (parseQuoteBody({ format: "framed", size: "30x40", frame: "black" }) as object),
    true,
  );
});

test("a non-Error thrown while building the body is reported, not rethrown", async () => {
  // Both catches in createProdigiOrder carry an `e instanceof Error ? e.message
  // : <default>` arm. Nothing in the code throws a non-Error today, so the
  // default arm is what a future throw site (or a bad toJSON) would hit — and
  // it must not become an unhandled rejection out of the webhook.
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  // createProdigiOrder now fails closed before the body builder when the
  // master cannot be signed; these tests are about the later catch arms, so
  // give it a usable secret.
  process.env.PRINT_ASSET_HMAC_SECRET = "defensive-branches-hmac-secret-32-ch!!";
  const originalFetch = globalThis.fetch;
  // A recipient field that throws a bare string when the body builder reads
  // it, which is what a non-Error throw site below the builder would look
  // like. An Error subclass would not do: the default arm is the one under
  // test.
  const hostile = {
    ...RECIPIENT,
    get name(): string {
      throw "not-an-error";
    },
  } as unknown as OrderRecipient;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: hostile,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "client");
    assert.equal(result.ok === false && result.message, "invalid-order-body");
    assert.equal(fetched, 0, "the request must not be sent");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY", "NEXT_PUBLIC_SITE_URL", "PRINT_ASSET_HMAC_SECRET"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a non-Error thrown by fetch is a server failure, not a crash", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  // createProdigiOrder now fails closed before the body builder when the
  // master cannot be signed; these tests are about the later catch arms, so
  // give it a usable secret.
  process.env.PRINT_ASSET_HMAC_SECRET = "defensive-branches-hmac-secret-32-ch!!";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw "socket exploded";
  }) as typeof fetch;
  try {
    const result = await createProdigiOrder({
      sessionId: "cs_test_abcdefgh",
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "50x70",
      frame: null,
      recipient: RECIPIENT,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "server");
    assert.equal(result.ok === false && result.message, "network-error");
    assert.equal(result.ok === false && result.status, null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["PRODIGI_API_BASE", "PRODIGI_SANDBOX_API_KEY", "NEXT_PUBLIC_SITE_URL", "PRINT_ASSET_HMAC_SECRET"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a physical order with no shippingEur stops as bad-metadata", () => {
  // The expected total is merchandise + shipping, so a physical order with no
  // shipping line has no total that can be verified. It stops here rather than
  // comparing the amount against merchandise + 0, which a 19.99 order would
  // otherwise fail for the wrong reason.
  const decided = decideFulfillment({
    sessionId: "cs_test_abcdefgh",
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1500,
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "giclee",
      size: "30x40",
      frame: "",
      quoteEur: "15",
    },
    shippingDetails: {
      name: "Test Buyer",
      phone: null,
      address: {
        line1: "1 Harbor St",
        line2: null,
        city: "Nessebar",
        state: null,
        postal_code: "8230",
        country: "BG",
      },
    },
    customerEmail: null,
    customerPhone: null,
    prodigiKeyConfigured: false,
    now: "2026-09-27T12:00:00.000Z",
  });
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.status, "paid-unfulfilled");
  assert.equal(record.reason, "bad-metadata");
  // Not amount-mismatch: the stop happened before any comparison, so the
  // amount is stored but never trusted.
  assert.equal(record.amountTotal, 1500);
});

test("a non-integer amountTotal is stored as 0 rather than a float", () => {
  const decided = decideFulfillment({
    sessionId: "cs_test_abcdefgh",
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1500.5 as number,
    metadata: null,
    shippingDetails: null,
    customerEmail: null,
    customerPhone: null,
    prodigiKeyConfigured: false,
    now: "2026-09-27T12:00:00.000Z",
  });
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.amountTotal, 0);
});

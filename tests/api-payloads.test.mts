import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutUrl,
  errorMessage,
  isLiveQuote,
} from "../src/lib/api-payloads.ts";

test("isLiveQuote accepts a well-formed quote", () => {
  assert.ok(isLiveQuote({ merchandiseEur: 12.5, shippingEur: 4 }));
  assert.ok(isLiveQuote({ merchandiseEur: 0, shippingEur: 0 }));
});

test("isLiveQuote rejects non-numeric amounts instead of trusting a cast", () => {
  assert.equal(isLiveQuote({ merchandiseEur: "12.5", shippingEur: 4 }), false);
  assert.equal(isLiveQuote({ merchandiseEur: 12.5, shippingEur: null }), false);
  assert.equal(isLiveQuote({ merchandiseEur: 12.5 }), false);
});

test("isLiveQuote rejects NaN, which would render as €NaN", () => {
  assert.equal(
    isLiveQuote({ merchandiseEur: Number.NaN, shippingEur: 4 }),
    false,
  );
  assert.equal(
    isLiveQuote({ merchandiseEur: 12.5, shippingEur: Number.NaN }),
    false,
  );
  assert.equal(
    isLiveQuote({ merchandiseEur: Infinity, shippingEur: 4 }),
    false,
  );
});

test("isLiveQuote rejects non-objects", () => {
  for (const value of [null, undefined, "12.5", 12.5, [], true]) {
    assert.equal(isLiveQuote(value), false);
  }
});

test("checkoutUrl returns an absolute https url", () => {
  assert.equal(
    checkoutUrl({ url: "https://checkout.stripe.com/c/pay/cs_123" }),
    "https://checkout.stripe.com/c/pay/cs_123",
  );
});

test("checkoutUrl refuses anything that is not an absolute https url", () => {
  assert.equal(checkoutUrl({ url: "http://example.com/pay" }), null);
  assert.equal(checkoutUrl({ url: "javascript:alert(1)" }), null);
  assert.equal(checkoutUrl({ url: "//example.com/pay" }), null);
  assert.equal(checkoutUrl({ url: "/pay" }), null);
});

test("checkoutUrl refuses https urls outside the Stripe checkout origin", () => {
  assert.equal(checkoutUrl({ url: "https://evil.example/pay" }), null);
  // Suffix, subdomain-suffix and userinfo tricks all resolve to a different
  // origin than the one allowlisted.
  assert.equal(checkoutUrl({ url: "https://evil-checkout.stripe.com/pay" }), null);
  assert.equal(checkoutUrl({ url: "https://checkout.stripe.com.evil.example/pay" }), null);
  assert.equal(checkoutUrl({ url: "https://checkout.stripe.com@evil.example/pay" }), null);
  assert.equal(checkoutUrl({ url: "https://stripe.com/c/pay/cs_123" }), null);
  assert.equal(checkoutUrl({ url: "https://checkout.stripe.com:8443/pay" }), null);
});

test("checkoutUrl returns null when the https url cannot be parsed", () => {
  // Passes the scheme pattern but is not a parseable URL, so the catch path
  // must return null rather than fall through to the redirect sink.
  assert.equal(checkoutUrl({ url: "https://" }), null);
  assert.equal(checkoutUrl({ url: "https:///" }), null);
});

test("checkoutUrl rejects missing or non-string urls", () => {
  assert.equal(checkoutUrl({}), null);
  assert.equal(checkoutUrl({ url: 42 }), null);
  assert.equal(checkoutUrl({ url: null }), null);
  assert.equal(checkoutUrl(null), null);
  assert.equal(checkoutUrl("https://example.com"), null);
});

test("errorMessage reads only a usable string, so the error path cannot throw", () => {
  assert.equal(errorMessage({ error: "Quote failed upstream" }), "Quote failed upstream");
  assert.equal(errorMessage({ error: "" }), null);
  assert.equal(errorMessage({ error: { message: "nested" } }), null);
  assert.equal(errorMessage({}), null);
  assert.equal(errorMessage(null), null);
  assert.equal(errorMessage("plain string"), null);
});

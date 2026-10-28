import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  checkoutUrl,
  isQuotePayload,
  isNonJsonBody,
  readJsonResponse,
} from "../src/application/checkout/api-payloads.ts";

test("isQuotePayload accepts a well-formed quote", () => {
  assert.ok(isQuotePayload({ merchandiseEur: 12.5, shippingEur: 4 }));
  assert.ok(isQuotePayload({ merchandiseEur: 0, shippingEur: 0 }));
});

test("isQuotePayload rejects non-numeric amounts instead of trusting a cast", () => {
  assert.equal(isQuotePayload({ merchandiseEur: "12.5", shippingEur: 4 }), false);
  assert.equal(isQuotePayload({ merchandiseEur: 12.5, shippingEur: null }), false);
  assert.equal(isQuotePayload({ merchandiseEur: 12.5 }), false);
});

test("isQuotePayload rejects NaN, which would render as €NaN", () => {
  assert.equal(
    isQuotePayload({ merchandiseEur: Number.NaN, shippingEur: 4 }),
    false,
  );
  assert.equal(
    isQuotePayload({ merchandiseEur: 12.5, shippingEur: Number.NaN }),
    false,
  );
  assert.equal(
    isQuotePayload({ merchandiseEur: Infinity, shippingEur: 4 }),
    false,
  );
});

test("isQuotePayload rejects non-objects", () => {
  for (const value of [null, undefined, "12.5", 12.5, [], true]) {
    assert.equal(isQuotePayload(value), false);
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

test("the payload reader never hands the server's own words to the page", () => {
  // The module that reads a response body has no reader for a message: a
  // failure body carries a code, and the copy for a code is the dictionary's,
  // in the reader's language. A reader here would be a second place where a
  // sentence written by the server reaches the customer.
  const source = fs.readFileSync(
    new URL("../src/application/checkout/api-payloads.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\.error\b/);
  assert.doesNotMatch(source, /requestErrorMessage|codeErrorMessage/);
});

/**
 * #130: the configurator called res.json() before checking res.ok, so a 502
 * answered with an HTML error page surfaced to the customer as
 * `Unexpected token '<'` — a JavaScript parse error describing our own client
 * instead of the outage that happened.
 */
test("a non-JSON body is reported as such rather than thrown", async () => {
  const html = new Response("<!DOCTYPE html><html>502</html>", { status: 502 });
  assert.equal(isNonJsonBody(await readJsonResponse(html)), true);
});

test("a JSON body is parsed whatever it is, including null and a list", async () => {
  assert.deepEqual(await readJsonResponse(Response.json({ a: 1 })), { a: 1 });
  assert.deepEqual(await readJsonResponse(Response.json([1, 2])), [1, 2]);
  assert.deepEqual(await readJsonResponse(Response.json(null)), null);
});

test("an empty body is a missing payload, not a parse failure", async () => {
  // The two are different reports: "the server sent nothing" versus "the
  // server sent something that was not JSON".
  assert.equal(isNonJsonBody(await readJsonResponse(new Response("", { status: 500 }))), false);
});

test("a body that cannot be read at all is still reportable by status", async () => {
  const broken = {
    ok: false,
    status: 500,
    text: async () => {
      throw new Error("connection reset");
    },
  } as unknown as Response;
  assert.equal(isNonJsonBody(await readJsonResponse(broken)), true);
});

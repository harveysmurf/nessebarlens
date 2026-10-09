import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutUrl,
  codeErrorMessage,
  errorMessage,
  isLiveQuote,
  isNonJsonBody,
  readJsonResponse,
  requestErrorMessage,
} from "../src/application/checkout/api-payloads.ts";

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

test("the error message names the status when the server sent no usable string", async () => {
  assert.equal(
    requestErrorMessage({ error: "Unknown photoSlug" }, 404, "Quote failed"),
    "Unknown photoSlug",
  );
  // The reported failure: an HTML 502 page has no `error` field to read. The
  // sentinel is the module's own, obtained the way the component gets it.
  const notJson = await readJsonResponse(
    new Response("<!DOCTYPE html>", { status: 502 }),
  );
  assert.equal(
    requestErrorMessage(notJson, 502, "Quote failed"),
    "Quote failed (502)",
  );
  assert.equal(requestErrorMessage(null, 400, "Checkout failed"), "Checkout failed (400)");
  assert.equal(requestErrorMessage({}, 503, "Checkout failed"), "Checkout failed (503)");
  assert.equal(
    requestErrorMessage({ error: "Checkout is not configured" }, 503, "Checkout failed"),
    "Checkout is not configured",
  );
});

test("a known failure code wins over the string in the body (#107)", () => {
  // The routes now send a code plus a safe message; the map is what the UI
  // actually shows, so a body whose `error` is anything else cannot reach the
  // customer through a code we recognise.
  assert.equal(
    requestErrorMessage(
      { code: "prodigi-unavailable", error: "Prodigi quote HTTP 429" },
      502,
      "Quote failed",
    ),
    "Pricing is temporarily unavailable, please try again.",
  );
  assert.equal(
    codeErrorMessage({ code: "checkout-unavailable" }),
    "Checkout is temporarily unavailable, please try again.",
  );
  // An unknown code is not swallowed: the server owns what is safe to say, and
  // a code from a newer deploy still shows its own message.
  assert.equal(codeErrorMessage({ code: "something-new" }), null);
  assert.equal(
    requestErrorMessage({ code: "something-new", error: "Upstream said no" }, 502, "Quote failed"),
    "Upstream said no",
  );
  assert.equal(codeErrorMessage("not-an-object"), null);
  assert.equal(codeErrorMessage({ code: 7 }), null);
});

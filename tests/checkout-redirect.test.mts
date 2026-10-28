import assert from "node:assert/strict";
import test from "node:test";
import { checkoutUrl } from "../src/application/checkout/api-payloads.ts";

/**
 * The redirect target, and nothing else.
 *
 * A failure body carries a code, not a sentence: the copy for the code is the
 * dictionary's and is rendered by the client, in the reader's language. What
 * this file holds is the part that has to be true whatever the body says —
 * the redirect target is refused unless it is an https URL on the Stripe
 * checkout origin, so a failure body cannot talk the page into navigating
 * somewhere else.
 */
test("a non-ok response never resolves a redirect target", () => {
  const data = { url: "http://evil.example/pay", code: "checkout-unavailable" };
  assert.equal(checkoutUrl(data), null);
});

test("an ok response with no usable url has nothing to redirect to", () => {
  for (const data of [
    { url: "https://evil.example/pay" },
    { url: "https://checkout.stripe.com:8443/pay" },
    {},
  ]) {
    assert.equal(checkoutUrl(data), null);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { checkoutUrl, errorMessage } from "../src/lib/api-payloads.ts";

test("a non-ok response surfaces the server's own error string", () => {
  // `checkoutUrl` rejects a non-https url, but the buyer's message must still
  // be what the server said rather than a generic one, so the status is
  // checked before the redirect target is resolved.
  const data = { url: "http://evil.example/pay", error: "Stripe unavailable" };
  assert.equal(checkoutUrl(data), null);
  assert.equal(errorMessage(data), "Stripe unavailable");
});

test("an ok response with no usable url has no server error to show", () => {
  // The only case the reorder changes: a success status whose `url` is refused
  // carries no `error` field, so both orderings end at the generic message.
  for (const data of [
    { url: "https://evil.example/pay" },
    { url: "https://checkout.stripe.com:8443/pay" },
    {},
  ]) {
    assert.equal(checkoutUrl(data), null);
    assert.equal(errorMessage(data), null);
  }
});

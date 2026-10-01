/**
 * The webhook compares the session's `amount_total` against the quote the
 * order record carries and rejects a mismatch. With Adaptive Pricing enabled,
 * a buyer is charged in their local currency; from API version
 * 2025-03-31.basil onwards the top-level `amount_total`/`currency` stay in
 * the integration currency (eur), which is why the check still holds.
 *
 * Two things used to make that an invisible dependency: the setting itself
 * lived in the Stripe dashboard rather than the code, and the guarantee is a
 * property of the API version the client happens to send, which followed
 * whatever the installed SDK pinned. #124 makes the setting explicit; these
 * tests hold the rest of the chain still.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

/**
 * The first API version whose `amount_total` is reported in the integration
 * currency regardless of Adaptive Pricing. Older than this, enabling the
 * setting would have made the webhook's amount check reject honest payments.
 */
const MIN_API_VERSION = { year: 2025, month: 3, day: 31, name: "basil" };

function parseApiVersion(raw: string): {
  year: number;
  month: number;
  day: number;
  name: string;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(.+)$/.exec(raw.trim());
  assert.ok(m, `unexpected Stripe API_VERSION shape: ${JSON.stringify(raw)}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    name: m[4],
  };
}

test("the SDK pins an API version at or after the adaptive-pricing amount semantics", () => {
  const v = parseApiVersion(Stripe.API_VERSION);
  const min = MIN_API_VERSION;
  const order =
    v.year * 10000 + v.month * 100 + v.day >= min.year * 10000 + min.month * 100 + min.day;
  assert.ok(
    order,
    `stripe@${Stripe.API_VERSION} pins ${v.name}, older than ${min.name}; ` +
      "`amount_total` would then follow the buyer's local currency and the " +
      "webhook's amount check would reject honest payments. Confirm the " +
      "checkout amount flow before bumping the SDK.",
  );
});

// That the parameter is actually sent is asserted against the captured
// form-encoded session params in tests/routes.test.mts, where the POST
// harness already exists; duplicating it here would be a second harness to
// keep in step.
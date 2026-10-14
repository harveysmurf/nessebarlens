/**
 * The Checkout Session shipping reader (#388).
 *
 * Stripe moved the address between `shipping_details` on the session root and
 * `collected_information.shipping_details`, and the SDK types name only the
 * second. The reader therefore reads two optional slots from a value the SDK
 * type cannot fully describe — which is exactly the kind of function that keeps
 * working after it stops being right. Both slots are exercised here against the
 * real `Stripe.Checkout.Session` type, so a session carrying the address in
 * either place has a test saying which field it lands in.
 *
 * `as Stripe.Checkout.Session` in the fixtures below is deliberate: the values
 * are partial session objects, and this is the only way to hand the reader an
 * SDK-typed value without a live API call. The assertion being tested is
 * *inside* the reader, so it is not the thing under test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { readSessionShipping } from "../src/infrastructure/stripe/stripe-gateway.ts";

const ADDRESS = {
  name: "Nessebar Tester",
  address: {
    line1: "1 Test Street",
    line2: null,
    city: "Nessebar",
    state: null,
    postal_code: "8230",
    country: "BG",
  },
};

/** A session carrying the address where the SDK types say it lives. */
function collectedSession(): Stripe.Checkout.Session {
  return {
    id: "cs_collected",
    collected_information: { shipping_details: ADDRESS },
  } as unknown as Stripe.Checkout.Session;
}

/** A session carrying it in the pre-API-version root slot the SDK dropped. */
function legacySession(): Stripe.Checkout.Session {
  return {
    id: "cs_legacy",
    shipping_details: ADDRESS,
  } as unknown as Stripe.Checkout.Session;
}

test("the collected_information slot is read into collectedShippingDetails", () => {
  const read = readSessionShipping(collectedSession());
  assert.equal(read.collectedShippingDetails?.name, "Nessebar Tester");
  assert.equal(read.collectedShippingDetails?.address?.city, "Nessebar");
  assert.equal(read.shippingDetails, null, "the other slot is not invented");
});

test("the legacy root slot is read into shippingDetails", () => {
  // The regression the reader exists for: before #388 this slot was reached
  // through `session as unknown as SessionShipping`, which type-checked nothing
  // on either side -- a rename of either field would have compiled and read
  // undefined at runtime.
  const read = readSessionShipping(legacySession());
  assert.equal(read.shippingDetails?.name, "Nessebar Tester");
  assert.equal(read.shippingDetails?.address?.postal_code, "8230");
  assert.equal(read.collectedShippingDetails, null);
});

test("a session with both slots reports both, never one merged into the other", () => {
  const read = readSessionShipping({
    id: "cs_both",
    shipping_details: { ...ADDRESS, name: "Legacy Name" },
    collected_information: { shipping_details: { ...ADDRESS, name: "Collected Name" } },
  } as unknown as Stripe.Checkout.Session);
  assert.equal(read.shippingDetails?.name, "Legacy Name");
  assert.equal(read.collectedShippingDetails?.name, "Collected Name");
});

test("a session with neither slot is null on both, not undefined", () => {
  const read = readSessionShipping({ id: "cs_bare" } as unknown as Stripe.Checkout.Session);
  assert.deepEqual(read, { shippingDetails: null, collectedShippingDetails: null });
});

test("an explicit null in a slot stays null rather than becoming undefined", () => {
  // `??` is what normalises these, and the difference is visible to a caller
  // that checks `=== null`.
  const read = readSessionShipping({
    id: "cs_null",
    shipping_details: null,
    collected_information: { shipping_details: null },
  } as unknown as Stripe.Checkout.Session);
  assert.equal(read.shippingDetails, null);
  assert.equal(read.collectedShippingDetails, null);
});

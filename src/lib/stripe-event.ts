import Stripe from "stripe";

/** Verify the Stripe-Signature header against the raw request body. */
export function constructStripeEvent(
  payload: string,
  header: string,
  secret: string,
): Stripe.Event {
  return Stripe.webhooks.constructEvent(payload, header, secret);
}

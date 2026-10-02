import Stripe from "stripe";
import { stripeSecretKey } from "./config";

/**
 * stripeSecretKey, not process.env: a whitespace-only key is truthy, so a bare
 * `if (!key)` check would build a Stripe client that fails every request with a
 * confusing 401 instead of failing here.
 */
export function getStripe(): Stripe {
  const key = stripeSecretKey();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}


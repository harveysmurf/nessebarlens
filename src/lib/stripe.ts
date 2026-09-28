import Stripe from "stripe";
import { envString, envStringStrippedSlash } from "./env";

/**
 * envString, not process.env: a whitespace-only key is truthy, so the old
 * `if (!key)` check built a Stripe client that failed every request with a
 * confusing 401 instead of failing here.
 */
export function getStripe(): Stripe {
  const key = envString("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Absolute origin, never trailing-slashed — callers concatenate paths onto it. */
export function siteUrl(): string {
  return envStringStrippedSlash("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000";
}

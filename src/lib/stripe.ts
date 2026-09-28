import Stripe from "stripe";
import { envStringStrippedSlash } from "./env";

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
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

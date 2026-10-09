import Stripe from "stripe";
import { stripeSecretKey } from "../config/config";

/**
 * Pinned, not inherited from the SDK default. Left unset, the API version every
 * request sends is whatever the installed `stripe` major pins, so a dependency
 * bump silently moves checkout and the revocation lookups onto a new API version
 * (#220: v23 moved it from 2026-08-26.dahlia to 2026-09-30.endive). The option
 * is typed as the SDK's latest version, so the next major turns this line into
 * a type error -- which is the point: moving the API version is a decision, made
 * here, not a side effect of a lockfile change. Keep
 * scripts/verify-stripe-integration.mjs on the same value.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

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
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}


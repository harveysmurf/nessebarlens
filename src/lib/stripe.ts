import Stripe from "stripe";
import { envString, envStringStrippedSlash } from "./env";

/**
 * envString, not process.env: a whitespace-only key is truthy, so a bare
 * `if (!key)` check would build a Stripe client that fails every request with a
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

/**
 * Absolute origin, never trailing-slashed — callers concatenate paths onto it.
 *
 * The localhost fallback is dev-only on purpose. NEXT_PUBLIC_* is inlined at
 * build time, so a production build missing the variable would otherwise ship
 * a checkout that redirects to http://localhost:3000 and Prodigi orders whose
 * signed asset URL points at localhost. Throwing keeps the failure on our side
 * of the request: /api/checkout turns it into a 503 before any money moves.
 */
export function siteUrl(): string {
  const configured = envStringStrippedSlash("NEXT_PUBLIC_SITE_URL");
  if (configured) return configured;
  if (isProduction()) {
    throw new Error("NEXT_PUBLIC_SITE_URL is not set");
  }
  return "http://localhost:3000";
}

/**
 * isConfiguredSiteUrl, for callers that need to decide before they resolve the
 * URL: a route must return 503, not build a Stripe session it will discard.
 */
export function isConfiguredSiteUrl(): boolean {
  return envStringStrippedSlash("NEXT_PUBLIC_SITE_URL") !== undefined;
}

function isProduction(): boolean {
  return envString("NODE_ENV") === "production";
}

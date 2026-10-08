/**
 * Composition root (#3, DDD).
 *
 * Route handlers ask for a port here instead of constructing a vendor client
 * inline. Each factory returns a concrete adapter; because the adapters read
 * their own configuration (and fail closed), there is nothing binding-specific
 * to thread through yet — the point is that there is exactly one place a future
 * binding or fake would be injected.
 *
 * Functions, not constants, on purpose: building a Stripe client at import time
 * would read the env during module load, which the config discipline in
 * `config.ts` deliberately avoids.
 */

import { stripeGateway, stripeReconcileStripe } from "./stripe-gateway";
import { prodigiPrintProvider } from "./print-provider";
import type { PaymentGateway } from "./payment-gateway";
import type { PrintProvider } from "./print-provider";
import type { ReconcileStripe } from "./reconcile";

/** The Stripe-backed payment gateway. */
export function paymentGateway(): PaymentGateway {
  return stripeGateway();
}

/** The Prodigi-backed print provider. */
export function printProvider(): PrintProvider {
  return prodigiPrintProvider();
}

/** The Stripe-backed reconciler read. */
export function reconcileStripe(): ReconcileStripe {
  return stripeReconcileStripe();
}

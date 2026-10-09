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

import { stripeGateway, stripeReconcileStripe, stripeSessionLookup } from "./stripe/stripe-gateway";
import { prodigiPrintProvider } from "./prodigi/print-provider";
import { cancelProdigiOrder } from "./prodigi/prodigi-cancel";
import { ConfiguredAssetUrlSigner } from "./print-asset/asset-url-signer";
import type { AssetUrlSigner } from "../domain/ordering/asset-url-signer";
import type { PaymentGateway } from "../application/checkout/payment-gateway";
import type { PrintProvider, CancelProdigiOrder } from "../domain/ordering/print-provider";
import type { ReconcileStripe } from "../application/fulfillment/reconcile";
import type { StripeSessionLookup } from "../domain/ordering/stripe-session-lookup";

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

/** The Stripe-backed session lookup (refunds/disputes). */
export function stripeSessionLookupPort(): StripeSessionLookup {
  return stripeSessionLookup();
}

/** The configured AssetUrlSigner (HMAC print-asset signing). */
export function assetUrlSigner(): AssetUrlSigner {
  return new ConfiguredAssetUrlSigner();
}

/** The Prodigi-backed order cancellation. */
export function prodigiCancel(): CancelProdigiOrder {
  return cancelProdigiOrder;
}

/**
 * Orders reconciler (#116).
 *
 * Two jobs, one entry point:
 *
 * 1. Retry every paid-unfulfilled / non-terminal order by re-entering
 *    `fulfillCheckoutSession` with a fresh Checkout Session from Stripe — the
 *    same code the webhook runs, so a retry cannot diverge from a redelivery.
 * 2. Catch a webhook we never received: list Stripe Checkout Sessions created
 *    in the lookback window with `payment_status: "paid"`, and for any session
 *    id with no stored order, run it through the same fulfillment entry point.
 *
 * Stuck orders (retryable and older than RECONCILE_STUCK_HOURS) emit
 * `order.stuck` for #100's alerting to consume. This module does not refund,
 * email, or page anyone.
 *
 * Safe to run twice concurrently and to overlap itself: the atomic claim inside
 * `fulfillCheckoutSession` (`transitionOrder` before Prodigi) is what makes
 * that true — a losing reconciler run answers duplicate and does not place a
 * second print.
 *
 * Triggered by POST /api/internal/reconcile from a GitHub Actions schedule, not
 * by a Cloudflare Cron Trigger: OpenNext's generated `.open-next/worker.js`
 * exports only `default { fetch }` plus the DO classes, so `[triggers] crons`
 * in wrangler.toml would be silently ignored for this Worker.
 */

import { classifyUrlOrigin } from "../../domain/ordering/session-origin";
import { fulfillCheckoutSession } from "./fulfillment";
import type { OrdersStore } from "../../domain/ordering/orders-store";
import type { CreateProdigiOrder } from "../../domain/ordering/print-provider";
import type { AssetUrlSigner } from "../../domain/ordering/asset-url-signer";
import type { DownloadTokenLimits } from "../../domain/ordering/download-token";
import type { StripeShippingDetails } from "../../domain/ordering/order-decision";

/** How many retryable orders one run will attempt. */
export const RECONCILE_BATCH = 50;

/** How far back to scan Stripe for paid sessions with no stored order. */
export const RECONCILE_LOOKBACK_HOURS = 48;

/** Age at which a still-retryable order emits `order.stuck`. */
export const RECONCILE_STUCK_HOURS = 24;

/**
 * The slice of Stripe this module needs. Injected so tests never construct a
 * real client — same pattern as order-revocation.ts.
 */
export type ReconcileStripe = {
  retrieveCheckoutSession(sessionId: string): Promise<ReconcileSession | null>;
  listPaidCheckoutSessions(input: {
    createdGte: number;
    limit: number;
  }): Promise<ReconcileSession[]>;
};

export type ReconcileSession = {
  id: string;
  payment_status: string | null;
  currency: string | null;
  amount_total: number | null;
  metadata: Record<string, string> | null;
  shipping_details: StripeShippingDetails | null;
  collected_information?: {
    shipping_details?: StripeShippingDetails | null;
  } | null;
  customer_details?: {
    email?: string | null;
    phone?: string | null;
  } | null;
  /** The origin record (#193); see classifyUrlOrigin. */
  success_url?: string | null;
};

export type ReconcileSummary = {
  retried: number;
  recovered: number;
  claimedByOther: number;
  stuck: number;
  checked: number;
  missed: number;
  /** Sessions skipped because another environment created them (#193). */
  foreign: number;
};

export type ReconcileInput = {
  store: OrdersStore;
  stripe: ReconcileStripe;
  prodigiKeyConfigured: boolean;
  /** The site origin, for foreign-session classification (#193). */
  siteUrl: string;
  /** The order function and asset signer, passed through to fulfillment. */
  createOrder: CreateProdigiOrder;
  assetUrlSigner: AssetUrlSigner;
  nowMs?: number;
  downloadLimits?: DownloadTokenLimits;
  batch?: number;
  lookbackHours?: number;
  stuckHours?: number;
};

export async function reconcileOrders(
  input: ReconcileInput,
): Promise<ReconcileSummary> {
  const nowMs = input.nowMs ?? Date.now();
  const batch = input.batch ?? RECONCILE_BATCH;
  const lookbackHours = input.lookbackHours ?? RECONCILE_LOOKBACK_HOURS;
  const stuckHours = input.stuckHours ?? RECONCILE_STUCK_HOURS;
  const summary: ReconcileSummary = {
    retried: 0,
    recovered: 0,
    claimedByOther: 0,
    stuck: 0,
    checked: 0,
    missed: 0,
    foreign: 0,
  };

  const retryable = await input.store.listOrders({
    retryable: true,
    limit: batch,
  });
  summary.checked = retryable.length;

  for (const order of retryable) {
    // parseOrderRecord already substituted updatedAt for a missing createdAt,
    // so there is no fallback to choose here.
    const ageHours = (nowMs - Date.parse(order.createdAt)) / (1000 * 60 * 60);
    if (Number.isFinite(ageHours) && ageHours >= stuckHours) {
      summary.stuck += 1;
      console.error(
        JSON.stringify({
          event: "order.stuck",
          sessionId: order.sessionId,
          status: order.status,
          reason: order.reason,
          attempts: order.attempts,
          ageHours: Math.round(ageHours * 10) / 10,
        }),
      );
    }

    const session = await input.stripe.retrieveCheckoutSession(order.sessionId);
    if (!session) continue;
    if (isForeign(session, summary)) continue;

    const result = await fulfillFromSession(input, session);
    if (result.body.duplicate === true) {
      summary.claimedByOther += 1;
    } else {
      summary.retried += 1;
    }
  }

  const createdGte = Math.floor(nowMs / 1000) - lookbackHours * 60 * 60;
  const paidSessions = await input.stripe.listPaidCheckoutSessions({
    createdGte,
    limit: batch,
  });
  for (const session of paidSessions) {
    if (isForeign(session, summary)) continue;
    const existing = await input.store.getOrder(session.id);
    if (existing !== null) continue;
    summary.missed += 1;
    await fulfillFromSession(input, session);
    summary.recovered += 1;
  }

  /**
   * Same classifier as the webhook (#193): the Stripe account lists every
   * environment's sessions, so the reconciler must refuse the ones it did not
   * create, or it would adopt and fulfil another deployment's payment.
   * `unknown` is accepted, exactly as in the webhook.
   */
  function isForeign(
    session: ReconcileSession,
    summary: ReconcileSummary,
  ): boolean {
    if (classifyUrlOrigin(session.success_url, input.siteUrl) !== "foreign") return false;
    summary.foreign += 1;
    console.warn(
      JSON.stringify({
        event: "reconcile.foreign-session",
        sessionId: session.id,
        sessionOrigin: session.success_url,
        siteOrigin: input.siteUrl,
      }),
    );
    return true;
  }

  return summary;
}

async function fulfillFromSession(
  input: ReconcileInput,
  session: ReconcileSession,
) {
  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null;
  return fulfillCheckoutSession({
    store: input.store,
    sessionId: session.id,
    paymentStatus: session.payment_status,
    currency: session.currency,
    amountTotal: session.amount_total,
    metadata: session.metadata,
    shippingDetails,
    customerEmail: session.customer_details?.email ?? null,
    customerPhone: session.customer_details?.phone ?? null,
    prodigiKeyConfigured: input.prodigiKeyConfigured,
    now: new Date(input.nowMs ?? Date.now()).toISOString(),
     createOrder: input.createOrder,
     assetUrlSigner: input.assetUrlSigner,
     siteUrl: input.siteUrl,
    downloadLimits: input.downloadLimits,
  });
}

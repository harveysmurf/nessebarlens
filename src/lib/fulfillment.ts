/**
 * The effects half of checkout fulfillment for the orders store (#116).
 *
 * `order-decision.ts` owns every rule about what a paid session *means* — what
 * a stored record says, whether an order may have its file, which status a
 * customer is shown. This module owns the four things that reach outside the
 * process: reading and writing the orders store, calling Prodigi, and answering
 * Stripe.
 *
 * It decides nothing on its own. Every branch here is a decision that
 * order-decision already made, or a Prodigi result being written back onto a
 * record the interpreter produced.
 *
 * Writes use the store's optimistic lock on retries: `transitionOrder` runs
 * *before* Prodigi so two concurrent redeliveries of the same paid-unfulfilled
 * session place one Prodigi order, not two. The loser sees `false` from the
 * row count and answers 200 `{ duplicate: true }` without calling Prodigi.
 */

import {
  createProdigiOrder,
  isRetryableProdigiReason,
  type CreateProdigiOrder,
} from "./prodigi-order";
import {
  AWAITING_PRODIGI_REASON,
  decideFulfillment,
  isUnfulfilledOutcome,
  type FulfillmentInput,
  type OrderRecord,
} from "./order-decision";
import { readOrderRecord } from "./order-corrupt";
import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  ensureDownloadToken,
  type DownloadTokenLimits,
} from "./download-token";
import type { FrameFinish, PrintSize } from "./pricing";
import type { PhysicalFormat } from "./sku-map";
import type { OrdersStore } from "./orders-store";

function reportUnfulfilled(record: OrderRecord, detail?: string): void {
  console.error(
    JSON.stringify({
      event: "order.unfulfilled",
      sessionId: record.sessionId,
      reason: record.reason,
      terminal: record.terminal,
      format: record.format,
      ...(detail === undefined ? {} : { detail }),
    }),
  );
}

async function storeNewOrder(
  store: OrdersStore,
  record: OrderRecord,
  detail?: string,
): Promise<void> {
  await store.putOrder(record);
  if (isUnfulfilledOutcome(record)) reportUnfulfilled(record, detail);
}

async function storeTransition(
  store: OrdersStore,
  fromAttempts: number,
  record: OrderRecord,
  detail?: string,
): Promise<boolean> {
  const ok = await store.transitionOrder({
    sessionId: record.sessionId,
    fromAttempts,
    record,
  });
  if (ok && isUnfulfilledOutcome(record)) reportUnfulfilled(record, detail);
  return ok;
}

/**
 * Mint a download token for a paid digital order, and only then (#111).
 *
 * Two conditions, both required. `format === "digital"` because a print has no
 * file to hand over — a token for one would be a link that 403s
 * `not-a-digital-download`. `status === "paid"` because the token is what
 * grants the master, and a paid-but-unfulfilled digital order has none: issuing
 * it early would hand out a link whose only outcome is a 409, and would look
 * like a working download on the success page.
 *
 * Failures are swallowed on purpose. The order is already stored and paid, and
 * a store error while writing a convenience record must not turn a fulfilled
 * order into a 5xx that makes Stripe redeliver it.
 */
async function issueTokenIfDigital(
  record: OrderRecord,
  store: OrdersStore,
  limits?: DownloadTokenLimits,
): Promise<void> {
  if (record.format !== "digital" || record.status !== "paid") return;
  const minted = await ensureDownloadToken({
    store,
    sessionId: record.sessionId,
    limits: limits ?? {
      ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
      maxDownloads: DOWNLOAD_TOKEN_MAX_DOWNLOADS,
    },
  });
  if (minted) return;
  console.error(
    JSON.stringify({
      event: "order.download-token-failed",
      sessionId: record.sessionId,
    }),
  );
}

export async function fulfillCheckoutSession(
  input: FulfillmentInput & {
    store: OrdersStore;
    createOrder?: CreateProdigiOrder;
    /**
     * Download-token policy (#111), passed in rather than read from the env:
     * this module is otherwise pure of configuration, and config.ts is the only
     * place that reads it. Defaults keep every existing caller and test working.
     */
    downloadLimits?: DownloadTokenLimits;
  },
): Promise<{ httpStatus: 200 | 500; body: Record<string, unknown> }> {
  const decision = decideFulfillment(input);
  if (decision.action === "ignore") {
    return {
      httpStatus: 200,
      body: { received: true, ignored: decision.reason },
    };
  }

  const existingRaw = await input.store.getOrder(decision.record.sessionId);
  // A record left behind by a retryable failure is not a duplicate: Stripe is
  // redelivering precisely so we can try again, and the stored order is where
  // the paid-but-unfulfilled state is visible to a human. Everything else that
  // is already stored is done, and re-running Prodigi would place a second
  // order for one payment.
  // A stored record we cannot parse is one we must not overwrite and must not
  // treat as a duplicate either: this answers 200 below, so Stripe stops
  // redelivering and a paid-but-unreadable order becomes invisible without a
  // trace. Logged through the one shape every read path uses.
  const retryRecord =
    existingRaw !== null
      ? readOrderRecord(existingRaw, decision.record.sessionId, "webhook")
      : null;
  const isRetry =
    retryRecord !== null &&
    retryRecord.status === "paid-unfulfilled" &&
    !retryRecord.terminal &&
    isRetryableProdigiReason(retryRecord.reason);

  if (existingRaw !== null && !isRetry) {
    // Mint here too, not only on the write path: a redelivery after a partial
    // failure is the only moment that can repair a paid digital order that has
    // a record but no token. `ensureDownloadToken` is idempotent, so this is a
    // read in the ordinary case.
    if (retryRecord) {
      await issueTokenIfDigital(retryRecord, input.store, input.downloadLimits);
    }
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }

  let record = isRetry ? retryRecord : decision.record;
  // The attempts value the claim must pass is the one just read. The lock is
  // only as good as that read: two racers both see `n`, one UPDATE matches,
  // the other matches zero rows — which is enough because the claim runs
  // before Prodigi below.
  let fromAttempts = isRetry ? retryRecord.attempts : null;

  if (isRetry && fromAttempts !== null) {
    // Claim the retry before any Prodigi call. A lost claim means another
    // worker already owns this redelivery — answer duplicate and do not place
    // a second print. Raw transitionOrder here (not storeTransition) so the
    // claim itself does not re-emit order.unfulfilled; the post-Prodigi write
    // is the one that reports an outcome.
    const claimed = await input.store.transitionOrder({
      sessionId: record.sessionId,
      fromAttempts,
      record: {
        ...record,
        updatedAt: input.now || record.updatedAt,
      },
    });
    if (!claimed) {
      console.error(
        JSON.stringify({
          event: "order.fulfill-claim-lost",
          sessionId: record.sessionId,
          fromAttempts,
        }),
      );
      return { httpStatus: 200, body: { received: true, duplicate: true } };
    }
    fromAttempts = fromAttempts + 1;
    record = {
      ...record,
      attempts: fromAttempts,
      updatedAt: input.now || record.updatedAt,
    };
  }

  if (
    record.status === "paid-unfulfilled" &&
    (record.reason === AWAITING_PRODIGI_REASON ||
      isRetryableProdigiReason(record.reason))
  ) {
    const create = input.createOrder ?? createProdigiOrder;
    const format = record.format as PhysicalFormat;
    const size = record.size as PrintSize;
    const frame = record.frame === "" ? null : (record.frame as FrameFinish);
    const recipient = record.recipient!;
    const result = await create({
      sessionId: record.sessionId,
      photoSlug: record.photoSlug,
      format,
      size,
      frame,
      recipient,
    });

    if (!result.ok && result.kind === "server") {
      // We hold paid money and cannot fulfil it. No auto-refund (Simo's call:
      // refunds are hard to reverse and a config failure wants eyes), so: write
      // the order with its specific reason, log loudly for a human, and answer
      // 5xx so Stripe keeps redelivering for ~3 days — long enough to fix the
      // key or the HMAC secret and still land the order.
      record = {
        ...record,
        // Same derivation as the client branch below, so the two can never
        // disagree about what a stored reason means.
        terminal: !isRetryableProdigiReason(result.reason),
        reason: result.reason,
        prodigiOrderId: null,
        prodigiStage: null,
        assetUrl: null,
      };
      if (fromAttempts !== null) {
        await storeTransition(input.store, fromAttempts, record, result.message);
      } else {
        await storeNewOrder(input.store, record, result.message);
      }
      return {
        httpStatus: 500,
        body: { error: result.reason, message: result.message },
      };
    }

    if (!result.ok) {
      record = {
        ...record,
        // Keep the specific cause. A single "prodigi-error" for an auth
        // failure, a rate limit and a malformed body makes the stored record
        // useless for telling "rotate the key" from "back off" from "we sent
        // something Prodigi does not accept".
        //
        // And derive `terminal` from that reason rather than inheriting it: on
        // a first attempt the shell happens to say terminal:true, but a
        // redelivery of a retryable failure spreads a record that says false,
        // so inheriting left a non-retryable validation error stored as
        // "still retryable" — the invariant "terminal ⇔ no further automatic
        // action" broken, and a reconciler or operator view (#116) that trusts
        // `terminal` would misreport the order. One function, so a reason
        // added to the retryable set cannot be stored with the wrong flag.
        terminal: !isRetryableProdigiReason(result.reason),
        reason: result.reason,
        prodigiOrderId: null,
        prodigiStage: null,
        assetUrl: null,
      };
    } else {
      record = {
        ...record,
        // The retry landed, so this session is finished: from here on a
        // redelivery is a plain duplicate.
        terminal: true,
        status: "paid",
        reason: null,
        masterKey: null,
        prodigiOrderId: result.orderId,
        prodigiStage: result.stage,
        assetUrl: result.assetUrl,
      };
    }
  }

  if (fromAttempts !== null) {
    await storeTransition(input.store, fromAttempts, record);
  } else {
    await storeNewOrder(input.store, record);
  }
  await issueTokenIfDigital(record, input.store, input.downloadLimits);
  return {
    httpStatus: 200,
    body: {
      received: true,
      status: record.status,
      reason: record.reason,
      prodigiOrderId: record.prodigiOrderId,
    },
  };
}

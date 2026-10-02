/**
 * The effects half of checkout fulfillment for ORDERS KV.
 *
 * `order-decision.ts` owns every rule about what a paid session *means* — what
 * a stored record says, whether an order may have its file, which status a
 * customer is shown. This module owns the four things that reach outside the
 * process: reading and writing ORDERS, calling Prodigi, and answering Stripe.
 *
 * It decides nothing on its own. Every branch here is a decision that
 * order-decision already made, or a Prodigi result being written back onto a
 * record the interpreter produced.
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
import type { FrameFinish, PrintSize } from "./pricing";
import type { PhysicalFormat } from "./sku-map";

export type OrdersKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

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

async function storeOrder(
  kv: OrdersKv,
  record: OrderRecord,
  detail?: string,
): Promise<void> {
  await kv.put(record.sessionId, JSON.stringify(record));
  if (isUnfulfilledOutcome(record)) reportUnfulfilled(record, detail);
}

export async function fulfillCheckoutSession(
  input: FulfillmentInput & {
    kv: OrdersKv;
    createOrder?: CreateProdigiOrder;
  },
): Promise<{ httpStatus: 200 | 500; body: Record<string, unknown> }> {
  const decision = decideFulfillment(input);
  if (decision.action === "ignore") {
    return {
      httpStatus: 200,
      body: { received: true, ignored: decision.reason },
    };
  }

  const existingRaw = await input.kv.get(decision.record.sessionId);
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
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }

  let record = isRetry ? retryRecord : decision.record;

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
      await storeOrder(input.kv, record, result.message);
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

  await storeOrder(input.kv, record);
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

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
  parseOrderRecord,
  type FulfillmentInput,
  type OrderRecord,
} from "./order-decision";
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
  const retryRecord =
    existingRaw !== null ? parseOrderRecord(existingRaw) : null;
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
        terminal: false,
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

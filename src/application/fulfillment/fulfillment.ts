/**
 * The effects half of checkout fulfillment for the orders store (#116 / #117).
 *
 * `order-decision.ts` owns every rule about what a paid session *means* — what
 * a stored record says, whether an order may have its file, which status a
 * customer is shown. This module owns the things that reach outside the
 * process: reading and writing the orders store, calling Prodigi, sending
 * customer email, and answering Stripe.
 *
 * It decides nothing on its own. Every branch here is a decision that
 * order-decision already made, or a Prodigi result being written back onto a
 * record the interpreter produced.
 *
 * Writes use the store's optimistic lock on retries: `transitionOrder` runs
 * *before* Prodigi so two concurrent redeliveries of the same paid-unfulfilled
 * session place one Prodigi order, not two. The loser sees `false` from the
 * row count and answers 200 `{ duplicate: true }` without calling Prodigi.
 *
 * Customer email (#117): confirmation and unfulfilled are keyed off OUR
 * terminal write, never a Prodigi callback. The kind is appended to
 * `emailsSent` in the same put/transition that persists the outcome, and
 * `sendEmail` runs only after that write succeeds. An email failure is
 * logged and ignored — it must never change the webhook's HTTP status or
 * the stored order.
 */

import {
  createProdigiOrder,
  type CreateProdigiOrder,
} from "../../infrastructure/prodigi/prodigi-order";
import { isRetryableProdigiReason } from "../../domain/ordering/prodigi-policy";
import {
  AWAITING_PRODIGI_REASON,
  decideFulfillment,
  isUnfulfilledOutcome,
  shouldRetry,
  withProdigiFailure,
  withProdigiSuccess,
  type FulfillmentInput,
  type OrderRecord,
} from "../../domain/ordering/order-decision";
import { readOrderRecord } from "../../domain/ordering/order-corrupt";
import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  ensureDownloadToken,
  type DownloadTokenLimits,
} from "./download-token";
import type { FrameFinish } from "../../domain/pricing/pricing";
import { isFrameFinishValue, isPrintSize } from "../../domain/pricing/sku-map";
import type { OrdersStore } from "../../infrastructure/cloudflare/orders-store";
import { emailCopyFor } from "../../domain/ordering/email-copy";
import type { EmailKind, SendEmail } from "../../domain/ordering/email";
import { siteUrl } from "../../infrastructure/config/config";

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
 * The address we may mail for this write. Prefers the Stripe customer email
 * (digital orders store no recipient); falls back to the shipping recipient.
 */
function emailForOrder(
  record: OrderRecord,
  customerEmail: string | null,
): string | null {
  const fromStripe =
    typeof customerEmail === "string" ? customerEmail.trim() : "";
  if (fromStripe.includes("@")) return fromStripe.slice(0, 254);
  const fromRecipient = record.recipient?.email;
  if (typeof fromRecipient === "string" && fromRecipient.includes("@")) {
    return fromRecipient.trim().slice(0, 254);
  }
  return null;
}

/**
 * Which customer email this write should claim.
 *
 * Invariant, not a guess: every write that reaches the claim below is either a
 * `paid` order (the customer bought something, confirm it) or one of our own
 * terminal unfulfilled outcomes (we owe them money, apologise). Both retryable
 * shapes — `awaiting-prodigi` and a non-terminal `prodigi-*` reason — return
 * earlier, before this point, because a redelivery may still place the order
 * and mailing the customer now would be wrong. That is why there is no `null`
 * and no separate terminal check: a third case here would mean the invariant
 * broke, and the cost of it is an unearned apology email, not a silent no-op.
 */
function emailKindForWrite(record: OrderRecord): EmailKind {
  return record.status === "paid" ? "order-confirmation" : "order-unfulfilled";
}

/** Only called once the caller has checked the kind is not already claimed. */
function withEmailClaim(
  record: OrderRecord,
  kind: EmailKind,
): OrderRecord {
  return { ...record, emailsSent: [...record.emailsSent, kind] };
}

async function sendClaimedEmail(input: {
  sendEmail: SendEmail | undefined;
  record: OrderRecord;
  kind: EmailKind;
  to: string;
}): Promise<void> {
  if (!input.sendEmail) return;
  const copy = emailCopyFor({
    kind: input.kind,
    sessionId: input.record.sessionId,
    siteUrl: siteUrl(),
  });
  try {
    const sent = await input.sendEmail({
      to: input.to,
      kind: input.kind,
      subject: copy.subject,
      text: copy.text,
      sessionId: input.record.sessionId,
    });
    if (!sent.ok) {
      console.error(
        JSON.stringify({
          event: "email.failed",
          kind: input.kind,
          sessionId: input.record.sessionId,
          message: sent.message,
        }),
      );
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "email.failed",
        kind: input.kind,
        sessionId: input.record.sessionId,
        message: e instanceof Error ? e.message : "email-threw",
      }),
    );
  }
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
  if (record.kind !== "digital" || record.status !== "paid") return;
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
    /**
     * Customer email (#117). Optional like `createOrder`: unset means the
     * caller (or the route) has already decided not to send — typically
     * because RESEND_API_KEY is missing. A failure inside sendEmail never
     * changes the HTTP status or the stored order.
     */
    sendEmail?: SendEmail;
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
  const isRetry = retryRecord !== null && shouldRetry(retryRecord);

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

    if (
      record.kind !== "physical" ||
      !isPrintSize(record.size) ||
      record.recipient === null ||
      (record.frame !== "" && !isFrameFinishValue(record.frame))
    ) {
      // A record in the retryable state that is not a complete physical order
      // cannot be a normal write: buildRecord only writes awaiting-prodigi and
      // the retryable reasons after the size/frame/recipient checks pass, so a
      // tampered or legacy record can name one of those reasons without the
      // physical shape. Park it as a terminal bad-metadata order — the same
      // reason buildRecord uses for metadata that names nothing we can fulfill —
      // so it is answered 200 and never retried into a Prodigi call that would
      // send it garbage.
      record = {
        ...record,
        terminal: true,
        reason: "bad-metadata",
        prodigiOrderId: null,
        prodigiStage: null,
        assetUrl: null,
      };
    } else {
      // `record` is a physical order with a valid size and recipient; its frame
      // is "" or a known finish, so it maps to FrameFinish | null without a cast.
      const frame: FrameFinish | null =
        record.frame === ""
          ? null
          : isFrameFinishValue(record.frame)
            ? record.frame
            : null;
      const result = await create({
        sessionId: record.sessionId,
        photoSlug: record.photoSlug,
        format: record.format,
        size: record.size,
        frame,
        recipient: record.recipient,
      });

      if (
        !result.ok &&
        (result.kind === "server" ||
          result.kind === "timeout" ||
          result.kind === "unconfigured")
      ) {
        // We hold paid money and cannot fulfil it. No auto-refund (Simo's call:
        // refunds are hard to reverse and a config failure wants eyes), so: write
        // the order with its specific reason, log loudly for a human, and answer
        // 5xx so Stripe keeps redelivering for ~3 days — long enough to fix the
        // key or the HMAC secret and still land the order.
        record = withProdigiFailure(record, result);
        // Retryable failures stay terminal:false — no apology email yet; a
        // redelivery or the reconciler may still land the order. Claim/send
        // only runs on the terminal write paths below.
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
        // The specific cause is kept — an auth failure, a rate limit and a
        // malformed body are different operator problems, and one "prodigi-error"
        // would tell nobody which to act on. `terminal` is derived from that same
        // reason inside the helper, never inherited: a redelivery of a retryable
        // failure would otherwise spread terminal:false onto a non-retryable
        // validation error, breaking "terminal ⇔ no further automatic action".
        record = withProdigiFailure(record, result);
      } else {
        // The retry landed, so this session is finished: from here on a
        // redelivery is a plain duplicate.
        record = withProdigiSuccess(record, result.value);
      }
    }
  }

  // Claim the email kind on the record *before* the write so a redelivery
  // that races us sees emailsSent already populated and does not send twice.
  // sendEmail runs only after the write succeeds.
  const kind = emailKindForWrite(record);
  const to = emailForOrder(record, input.customerEmail);
  const wantsEmail = to !== null && !record.emailsSent.includes(kind);
  // Claim only when a sender is wired. An unset RESEND_API_KEY must not
  // burn the kind on the record — otherwise fixing the key later can never
  // mail a customer whose order already carries emailsSent.
  if (wantsEmail && !input.sendEmail) {
    console.error(
      JSON.stringify({
        event: "email.skipped",
        reason: "resend-unconfigured",
        kind,
        sessionId: record.sessionId,
      }),
    );
  }
  const shouldEmail = wantsEmail && input.sendEmail !== undefined;
  if (shouldEmail) {
    record = withEmailClaim(record, kind);
  }

  if (fromAttempts !== null) {
    const ok = await storeTransition(input.store, fromAttempts, record);
    if (!ok) {
      // Lost the lock: another worker owns this write. Do not send mail —
      // the winner's record carries the claim (or will).
      return {
        httpStatus: 200,
        body: { received: true, duplicate: true },
      };
    }
  } else {
    await storeNewOrder(input.store, record);
  }

  if (shouldEmail && to) {
    await sendClaimedEmail({
      sendEmail: input.sendEmail,
      record,
      kind,
      to,
    });
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

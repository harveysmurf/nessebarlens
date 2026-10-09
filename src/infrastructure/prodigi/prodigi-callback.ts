/**
 * Prodigi CloudEvent callback effects (#117).
 *
 * Free of `next/server`. The route reads the raw body, checks the bearer
 * token, and maps the result of `handleProdigiCallback` onto JSON/status.
 *
 * Prodigi v4 documents no HMAC and no shared secret on callbacks. Auth is
 * ours alone (Authorization bearer on the route). The body is only a
 * trigger: we parse enough of the CloudEvent to know which order to
 * re-fetch, then persist stage and shipments from our own GET — never from
 * `data`. Event `type` is not an enum; only one literal is documented, so
 * any well-formed CloudEvent whose `subject` is an order we know is
 * accepted and re-fetched. No event-type allowlist.
 *
 * Unknown order (a `subject` we have no record for, or a missing/stale
 * subject after fetch): log and drop, answer 200. Do NOT upsert from the
 * callback or from the fetch — a record we never wrote has no verified
 * price, recipient or format, and fabricating one would put money-denying
 * data in the orders table. Answer 200 so Prodigi stops retrying, and
 * `console.error` a structured line with the subject.
 *
 * Ordering and email idempotency:
 *
 *   1. Parse the CloudEvent (reject malformed without 500).
 *   2. Fetch the Prodigi order by `subject` (5xx on failure so Prodigi
 *      retries; no store write yet — a claim before a failed fetch would
 *      eat the retry).
 *   3. Resolve our record via the fetched `merchantReference`; require
 *      `prodigiOrderId === subject`. Unknown → 200 + log, no write.
 *   4. `claimProdigiCallback(event.id)` — false ⇒ 200 `{ duplicate: true }`.
 *   5. If `print-shipped` is already in `emailsSent`, skip the send (still
 *      refresh stage/shipments).
 *   6. `transitionOrder` writing stage + shipments + the appended kind
 *      (when sending). A lost lock ⇒ 200 duplicate, no email.
 *   7. Only after the transition succeeds, call `sendEmail`.
 *
 * Residual window: between a successful Resend HTTP call and a lost
 * response, Resend's `Idempotency-Key: <sessionId>:<kind>` prevents a
 * second message. Between our store claim and the HTTP call, a crash
 * leaves the kind in `emailsSent` and never sends — preferred over a
 * double-send.
 */

import { emailCopyFor } from "../../domain/ordering/email-copy";
import type { EmailKind, SendEmail } from "../../domain/ordering/email";
import {
  isCheckoutSessionId,
  SHIPMENT_CARRIER_MAX,
  SHIPMENT_STATUS_MAX,
  SHIPMENT_TRACKING_NUMBER_MAX,
  SHIPMENT_TRACKING_URL_MAX,
  SHIPMENTS_MAX,
  type OrderRecord,
  type OrderShipment,
} from "../../domain/ordering/order-decision";
import { readOrderRecord } from "../../domain/ordering/order-corrupt";
import { isSafeProdigiOrderId } from "./prodigi-cancel";
import {
  detailSuffix,
  isProdigiTimeout,
  PRODIGI_ORDER_TIMEOUT_MS,
  prodigiTimeoutSignal,
  prodigiUrl,
} from "./prodigi-config";
import { prodigiConfig, siteUrl } from "../config/config";
import type { OrdersStore } from "../cloudflare/orders-store";

/** CloudEvent fields we require. Everything else is ignored. */
export type ProdigiCloudEvent = {
  specversion: string;
  id: string;
  subject: string;
};

export type ProdigiFetchedOrder = {
  orderId: string;
  merchantReference: string | null;
  stage: string | null;
  shipments: OrderShipment[];
};

export type FetchProdigiOrder = (
  orderId: string,
) => Promise<
  | { ok: true; value: ProdigiFetchedOrder }
  | { ok: false; message: string; status: number | null }
>;

export type ProdigiCallbackResult = {
  httpStatus: 200 | 400 | 500;
  body: Record<string, unknown>;
};

/**
 * Defensive CloudEvent parse. Accepts both documented `data` shapes
 * (`{ order: {...} }` and a bare order object) but never returns `data` —
 * callers must re-fetch. Requires `specversion`, non-empty `id`, and a
 * string `subject`.
 */
export function parseProdigiCloudEvent(
  raw: string,
):
  | { ok: true; event: ProdigiCloudEvent }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, error: "invalid-cloudevent" };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.specversion !== "string" || row.specversion.length === 0) {
    return { ok: false, error: "missing-specversion" };
  }
  if (typeof row.id !== "string" || row.id.length === 0) {
    return { ok: false, error: "missing-id" };
  }
  if (typeof row.subject !== "string" || row.subject.length === 0) {
    return { ok: false, error: "missing-subject" };
  }
  // Touch `data` only to accept both documented nestings without rejecting
  // a well-formed envelope. The value is discarded on purpose.
  void normalizeCallbackData(row.data);
  return {
    ok: true,
    event: {
      specversion: row.specversion,
      id: row.id,
      subject: row.subject,
    },
  };
}

/**
 * Accept both `{ order: {...} }` and a bare order-shaped object so a Prodigi
 * payload that follows either half of their inconsistent docs still parses.
 * Returns null for anything else; the caller never uses the result for state.
 */
function normalizeCallbackData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row.order && typeof row.order === "object") {
    return row.order as Record<string, unknown>;
  }
  return row;
}


/**
 * Map a Prodigi order JSON object onto the fields we persist. Exported for
 * tests that assert the fetch — not the callback body — wins.
 */
export function shipmentsFromProdigiOrder(order: unknown): OrderShipment[] {
  if (!order || typeof order !== "object") return [];
  const row = order as Record<string, unknown>;
  const raw = row.shipments;
  if (!Array.isArray(raw)) return [];
  const out: OrderShipment[] = [];
  for (const entry of raw) {
    if (out.length >= SHIPMENTS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    const tracking =
      s.tracking && typeof s.tracking === "object"
        ? (s.tracking as Record<string, unknown>)
        : {};
    const carrier =
      s.carrier && typeof s.carrier === "object"
        ? (s.carrier as Record<string, unknown>)
        : {};
    out.push({
      status: clip(s.status, SHIPMENT_STATUS_MAX),
      carrier: clip(
        typeof carrier.name === "string" ? carrier.name : s.carrier,
        SHIPMENT_CARRIER_MAX,
      ),
      trackingUrl: clip(tracking.url, SHIPMENT_TRACKING_URL_MAX),
      trackingNumber: clip(tracking.number, SHIPMENT_TRACKING_NUMBER_MAX),
    });
  }
  return out;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

function stageFromProdigiOrder(order: unknown): string | null {
  if (!order || typeof order !== "object") return null;
  const status = (order as Record<string, unknown>).status;
  if (!status || typeof status !== "object") return null;
  const stage = (status as Record<string, unknown>).stage;
  return typeof stage === "string" && stage.length > 0 ? stage : null;
}

function merchantReferenceFromProdigiOrder(order: unknown): string | null {
  if (!order || typeof order !== "object") return null;
  const ref = (order as Record<string, unknown>).merchantReference;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

/**
 * Live GET of a Prodigi order. Injectable as `fetchOrder` in tests.
 */
export const fetchProdigiOrder: FetchProdigiOrder = async (orderId) => {
  if (!isSafeProdigiOrderId(orderId)) {
    return { ok: false, message: "unsafe Prodigi order id", status: null };
  }
  const config = prodigiConfig();
  if (!config.ok) {
    return { ok: false, message: config.message, status: null };
  }

  const signal = prodigiTimeoutSignal(PRODIGI_ORDER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(prodigiUrl(config.base, `v4.0/orders/${orderId}`), {
      method: "GET",
      headers: { "X-API-Key": config.key },
      signal,
    });
  } catch (e) {
    if (isProdigiTimeout(e, signal)) {
      return {
        ok: false,
        message: `Prodigi fetch timed out after ${PRODIGI_ORDER_TIMEOUT_MS}ms`,
        status: null,
      };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "network-error",
      status: null,
    };
  }

  const raw = await res.text().then(
    (t) => t,
    () => "",
  );
  if (!res.ok) {
    return {
      ok: false,
      message: `Prodigi fetch HTTP ${res.status}${detailSuffix(raw)}`,
      status: res.status,
    };
  }

  let data: { order?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return { ok: false, message: "Prodigi fetch invalid JSON", status: res.status };
  }

  const order = data.order;
  if (!order || typeof order !== "object") {
    return { ok: false, message: "Prodigi fetch missing order", status: res.status };
  }
  const id = (order as Record<string, unknown>).id;
  if (typeof id !== "string" || !id) {
    return { ok: false, message: "Prodigi fetch missing order id", status: res.status };
  }

  return {
    ok: true,
    value: {
      orderId: id,
      merchantReference: merchantReferenceFromProdigiOrder(order),
      stage: stageFromProdigiOrder(order),
      shipments: shipmentsFromProdigiOrder(order),
    },
  };
};

function firstShipped(shipments: OrderShipment[]): OrderShipment | null {
  for (const s of shipments) {
    if (s.status === "Shipped") return s;
  }
  return null;
}

function recipientEmail(record: OrderRecord): string | null {
  const email = record.recipient?.email;
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  return trimmed.includes("@") ? trimmed : null;
}

/**
 * Process one Prodigi CloudEvent callback. See module JSDoc for ordering.
 */
export async function handleProdigiCallback(input: {
  rawBody: string;
  store: OrdersStore;
  /**
   * Optional like fulfillment's sendEmail. Unset means RESEND_API_KEY is
   * missing — log a skip and do not claim `print-shipped` on the record.
   */
  sendEmail?: SendEmail;
  fetchOrder?: FetchProdigiOrder;
  now: string;
  /** Override site origin for email copy (tests). */
  siteUrl?: string;
}): Promise<ProdigiCallbackResult> {
  const parsed = parseProdigiCloudEvent(input.rawBody);
  if (!parsed.ok) {
    return { httpStatus: 400, body: { error: parsed.error } };
  }
  const { event } = parsed;
  const fetchOrder = input.fetchOrder ?? fetchProdigiOrder;

  const fetched = await fetchOrder(event.subject);
  if (!fetched.ok) {
    console.error(
      JSON.stringify({
        event: "prodigi.callback.fetch-failed",
        subject: event.subject,
        cloudEventId: event.id,
        message: fetched.message,
      }),
    );
    return {
      httpStatus: 500,
      body: { error: "prodigi-fetch-failed", message: fetched.message },
    };
  }

  const merchantReference = fetched.value.merchantReference;
  if (
    !merchantReference ||
    !isCheckoutSessionId(merchantReference) ||
    fetched.value.orderId !== event.subject
  ) {
    console.error(
      JSON.stringify({
        event: "prodigi.callback.unknown-order",
        subject: event.subject,
        cloudEventId: event.id,
        merchantReference,
      }),
    );
    return { httpStatus: 200, body: { received: true, ignored: "unknown-order" } };
  }

  const existingRaw = await input.store.getOrder(merchantReference);
  const record =
    existingRaw !== null
      ? readOrderRecord(existingRaw, merchantReference, "prodigi-callback")
      : null;
  if (
    record === null ||
    record.prodigiOrderId !== event.subject
  ) {
    console.error(
      JSON.stringify({
        event: "prodigi.callback.unknown-order",
        subject: event.subject,
        cloudEventId: event.id,
        merchantReference,
      }),
    );
    return { httpStatus: 200, body: { received: true, ignored: "unknown-order" } };
  }

  const claimed = await input.store.claimProdigiCallback(event.id);
  if (!claimed) {
    return {
      httpStatus: 200,
      body: { received: true, duplicate: true },
    };
  }

  const shipped = firstShipped(fetched.value.shipments);
  const alreadySent = record.emailsSent.includes("print-shipped");
  const to = recipientEmail(record);
  const wantsShippedMail =
    shipped !== null && !alreadySent && to !== null;
  if (wantsShippedMail && !input.sendEmail) {
    console.error(
      JSON.stringify({
        event: "email.skipped",
        reason: "resend-unconfigured",
        kind: "print-shipped" satisfies EmailKind,
        sessionId: record.sessionId,
      }),
    );
  }
  const shouldSendShipped =
    wantsShippedMail && input.sendEmail !== undefined;

  const emailsSent: EmailKind[] = shouldSendShipped
    ? [...record.emailsSent, "print-shipped"]
    : record.emailsSent;

  const next: OrderRecord = {
    ...record,
    prodigiStage: fetched.value.stage,
    shipments: fetched.value.shipments,
    emailsSent,
    updatedAt: input.now,
  };

  const locked = await input.store.transitionOrder({
    sessionId: record.sessionId,
    fromAttempts: record.attempts,
    record: next,
  });
  if (!locked) {
    return {
      httpStatus: 200,
      body: { received: true, duplicate: true },
    };
  }

  if (shouldSendShipped && shipped && to && input.sendEmail) {
    const copy = emailCopyFor({
      kind: "print-shipped",
      sessionId: record.sessionId,
      siteUrl: input.siteUrl ?? siteUrl(),
      trackingNumber: shipped.trackingNumber,
      carrier: shipped.carrier,
      trackingUrl: shipped.trackingUrl,
    });
    try {
      const sent = await input.sendEmail({
        to,
        kind: "print-shipped",
        subject: copy.subject,
        text: copy.text,
        sessionId: record.sessionId,
      });
      if (!sent.ok) {
        console.error(
          JSON.stringify({
            event: "email.failed",
            kind: "print-shipped",
            sessionId: record.sessionId,
            message: sent.message,
          }),
        );
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "email.failed",
          kind: "print-shipped",
          sessionId: record.sessionId,
          message: e instanceof Error ? e.message : "email-threw",
        }),
      );
    }
  }

  return {
    httpStatus: 200,
    body: {
      received: true,
      stage: fetched.value.stage,
      shipped: shipped !== null,
    },
  };
}

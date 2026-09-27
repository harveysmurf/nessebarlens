/**
 * Checkout fulfillment decisions for ORDERS KV.
 * Prodigi is not called from this module. Physical payments are recorded
 * as paid-unfulfilled until a SKU map and a rotated sandbox key exist.
 *
 * EU_FLAT_SHIPPING_CENTS must stay equal to the checkout route's constant.
 * The only master-key list is photos.ts imageKey, via masterKeyForSlug.
 */

import { masterKeyForSlug } from "./master-key";

export const EU_FLAT_SHIPPING_CENTS = 1200;

/**
 * Keep false. paid-unfulfilled is written with HTTP 200, so Stripe does not
 * redeliver those events. Turning this on later does not replay them.
 */
export const SKU_MAP_READY = false;

const FORMATS = ["giclee", "framed", "canvas", "digital"] as const;

export type PrintFormat = (typeof FORMATS)[number];
export type OrderFormat = PrintFormat | "unknown";
export type OrderStatus = "paid" | "paid-unfulfilled";

export type OrderRecord = {
  v: 1;
  sessionId: string;
  merchantReference: string;
  /** Webhook already returned 200. Stripe will not redeliver this session. */
  terminal: true;
  status: OrderStatus;
  photoSlug: string;
  format: OrderFormat;
  size: string;
  frame: string;
  quoteEur: number;
  amountTotal: number;
  currency: "eur";
  reason: string | null;
  masterKey: string | null;
  updatedAt: string;
};

export type OrdersKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

export type MasterObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
};

export type MastersBucket = {
  get(key: string): Promise<MasterObject | null>;
};

export type FulfillmentInput = {
  sessionId: string;
  paymentStatus: string | null;
  currency: string | null;
  amountTotal: number | null;
  metadata: Record<string, string> | null;
  prodigiKeyConfigured: boolean;
  now: string;
};

export function isCheckoutSessionId(value: string): boolean {
  return /^cs_(test|live)_[A-Za-z0-9]{8,}$/.test(value);
}

export function expectedAmountCents(format: PrintFormat, quoteEur: number): number {
  const shipping = format === "digital" ? 0 : EU_FLAT_SHIPPING_CENTS;
  return quoteEur * 100 + shipping;
}

export function decideFulfillment(
  input: FulfillmentInput,
):
  | { action: "ignore"; reason: string }
  | { action: "write"; record: OrderRecord } {
  if (!isCheckoutSessionId(input.sessionId)) {
    return { action: "ignore", reason: "invalid-session-id" };
  }
  if (input.paymentStatus !== "paid") {
    return { action: "ignore", reason: "unpaid" };
  }
  return { action: "write", record: buildRecord(input) };
}

export async function fulfillCheckoutSession(
  input: FulfillmentInput & { kv: OrdersKv },
): Promise<{ httpStatus: 200; body: Record<string, unknown> }> {
  const decision = decideFulfillment(input);
  if (decision.action === "ignore") {
    return {
      httpStatus: 200,
      body: { received: true, ignored: decision.reason },
    };
  }

  const existing = await input.kv.get(decision.record.sessionId);
  if (existing !== null) {
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }

  await input.kv.put(
    decision.record.sessionId,
    JSON.stringify(decision.record),
  );
  return {
    httpStatus: 200,
    body: {
      received: true,
      status: decision.record.status,
      reason: decision.record.reason,
    },
  };
}

export function parseOrderRecord(raw: string): OrderRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return null;
  if (typeof row.sessionId !== "string" || !isCheckoutSessionId(row.sessionId)) {
    return null;
  }
  if (row.merchantReference !== row.sessionId) return null;
  if (row.terminal !== true) return null;
  if (row.status !== "paid" && row.status !== "paid-unfulfilled") return null;
  if (!isOrderFormat(row.format)) return null;
  if (typeof row.photoSlug !== "string") return null;
  if (typeof row.size !== "string" || typeof row.frame !== "string") return null;
  if (!isInt(row.quoteEur) || !isInt(row.amountTotal)) return null;
  if (row.currency !== "eur") return null;
  if (!(row.reason === null || typeof row.reason === "string")) return null;
  if (!(row.masterKey === null || typeof row.masterKey === "string")) return null;
  if (typeof row.updatedAt !== "string") return null;

  if (row.status === "paid") {
    const expectedKey = masterKeyForSlug(row.photoSlug);
    if (
      row.format !== "digital" ||
      !expectedKey ||
      row.masterKey !== expectedKey
    ) {
      return null;
    }
  } else if (row.masterKey !== null) {
    return null;
  }

  return {
    v: 1,
    sessionId: row.sessionId,
    merchantReference: row.sessionId,
    terminal: true,
    status: row.status,
    photoSlug: row.photoSlug,
    format: row.format,
    size: row.size,
    frame: row.frame,
    quoteEur: row.quoteEur,
    amountTotal: row.amountTotal,
    currency: "eur",
    reason: row.reason,
    masterKey: row.masterKey,
    updatedAt: row.updatedAt,
  };
}

export type DownloadResolution =
  | { kind: "json"; status: number; body: Record<string, string> }
  | {
      kind: "stream";
      body: ReadableStream<Uint8Array>;
      contentType: string;
      size: number;
      filename: string;
    };

export async function resolveDownload(
  order: OrderRecord,
  masters: MastersBucket | undefined,
): Promise<DownloadResolution> {
  if (order.format !== "digital") {
    return {
      kind: "json",
      status: 403,
      body: { error: "not-a-digital-download" },
    };
  }
  if (order.status !== "paid" || !order.masterKey) {
    return {
      kind: "json",
      status: 409,
      body: {
        error: "download-unavailable",
        reason: order.reason ?? "unfulfilled",
      },
    };
  }
  if (!masters) {
    return {
      kind: "json",
      status: 503,
      body: { error: "masters-unavailable" },
    };
  }

  let object: MasterObject | null;
  try {
    object = await masters.get(order.masterKey);
  } catch {
    return {
      kind: "json",
      status: 503,
      body: { error: "masters-unavailable" },
    };
  }
  if (!object) {
    return { kind: "json", status: 404, body: { error: "master-not-found" } };
  }

  const filename = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(order.photoSlug)
    ? `${order.photoSlug}.jpg`
    : "download.jpg";

  return {
    kind: "stream",
    body: object.body,
    contentType: object.contentType || "image/jpeg",
    size: object.size,
    filename,
  };
}

function buildRecord(input: FulfillmentInput): OrderRecord {
  const meta = input.metadata ?? {};
  const format = parseFormat(meta.format);
  const quoteEur = parseQuoteEur(meta.quoteEur);
  const photoSlug = typeof meta.photoSlug === "string" ? meta.photoSlug : "";
  const masterKey = masterKeyForSlug(photoSlug);
  const size = clip(meta.size);
  const frame = clip(meta.frame);

  const shell = {
    v: 1 as const,
    sessionId: input.sessionId,
    merchantReference: input.sessionId,
    terminal: true as const,
    photoSlug,
    size,
    frame,
    quoteEur: quoteEur ?? 0,
    amountTotal: isInt(input.amountTotal) ? input.amountTotal : 0,
    currency: "eur" as const,
    updatedAt: input.now,
    masterKey: null,
  };

  if (!format || quoteEur === null || !photoSlug) {
    return {
      ...shell,
      format: format ?? "unknown",
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }
  if (!masterKey) {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "unknown-photo",
    };
  }

  const expected = expectedAmountCents(format, quoteEur);
  if (input.currency !== "eur" || input.amountTotal !== expected) {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "amount-mismatch",
    };
  }

  if (format === "digital") {
    return {
      ...shell,
      format,
      status: "paid",
      reason: null,
      masterKey,
    };
  }

  let reason = "prodigi-disabled";
  if (!SKU_MAP_READY) reason = "sku-map-missing";
  else if (!input.prodigiKeyConfigured) reason = "prodigi-key-unset";

  return {
    ...shell,
    format,
    status: "paid-unfulfilled",
    reason,
  };
}

function parseFormat(raw: string | undefined): PrintFormat | null {
  if (raw && (FORMATS as readonly string[]).includes(raw)) {
    return raw as PrintFormat;
  }
  return null;
}

function parseQuoteEur(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,5}$/.test(raw)) return null;
  return Number(raw);
}

function clip(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, 64);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isOrderFormat(value: unknown): value is OrderFormat {
  return (
    value === "unknown" ||
    (typeof value === "string" && (FORMATS as readonly string[]).includes(value))
  );
}

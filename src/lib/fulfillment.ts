/**
 * Checkout fulfillment for ORDERS KV.
 * Digital: paid + masterKey for /api/download.
 * Physical: Prodigi order on payment; asset URL is HMAC /api/print-asset
 * (or placeholder). Masters never leave photos.ts / MASTERS binding.
 */

import { masterKeyForSlug } from "./master-key";
import { referencesMasters } from "./master-guard";
import {
  createProdigiOrder,
  isRetryableProdigiReason,
  type CreateProdigiOrder,
  type OrderRecipient,
} from "./prodigi-order";
import {
  eurToCents,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "./pricing";
import {
  FRAME_FINISHES,
  PRINT_SIZES,
  SELLABLE_FORMATS,
  type PhysicalFormat,
} from "./sku-map";
import { siteUrl } from "./stripe";

/**
 * The SKU map and the sandbox order path are wired.
 *
 * This used to be read as a runtime gate: buildRecord checked it and had a
 * try/catch around resolveSku, so a format with no pinned SKU would park the
 * order as "sku-map-missing" or "bad-metadata". Both branches were
 * unreachable — the flag is a literal and the isPrintSize/isFrameFinish guards
 * above already reject anything resolveSku would refuse. The guarantee is now
 * a test instead (sku-map.test.mts, "every UI format×size resolves to a
 * pinned Prodigi SKU"), which is where it can actually fail loudly.
 */
export const SKU_MAP_READY = true;

// The allow-list below is the sku-map list, so stored-record validation cannot
// drift from the formats we can actually fulfill.
const FORMATS: readonly PrintFormat[] = SELLABLE_FORMATS;

export type { PrintFormat };
export type OrderFormat = PrintFormat | "unknown";
export type OrderStatus = "paid" | "paid-unfulfilled";

export type { OrderRecipient };

export type OrderRecord = {
  v: 1;
  sessionId: string;
  merchantReference: string;
  /**
   * True when this delivery attempt is finished (the webhook answered 200, so
   * Stripe will not redeliver this session). False only for the retryable
   * Prodigi failures: we answered 5xx, the record is there so a human can see
   * the paid-but-unfulfilled order, and a redelivery must be allowed to retry
   * it rather than being rejected as a duplicate.
   */
  terminal: boolean;
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
  recipient: OrderRecipient | null;
  prodigiOrderId: string | null;
  prodigiStage: string | null;
  /** HMAC /api/print-asset or public placeholder — never a MASTERS key/URL. */
  assetUrl: string | null;
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

export type StripeShippingDetails = {
  name?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
};

export type FulfillmentInput = {
  sessionId: string;
  paymentStatus: string | null;
  currency: string | null;
  amountTotal: number | null;
  metadata: Record<string, string> | null;
  shippingDetails: StripeShippingDetails | null;
  customerEmail: string | null;
  customerPhone: string | null;
  prodigiKeyConfigured: boolean;
  now: string;
};

export function isCheckoutSessionId(value: string): boolean {
  return /^cs_(test|live)_[A-Za-z0-9]{8,}$/.test(value);
}

export function expectedAmountCents(
  format: PrintFormat,
  quoteEur: number,
  shippingEur = 0,
): number {
  // eurToCents is the one EUR→cents rounding in the repo; Stripe, the webhook
  // amount check and the stored record must not each redefine it.
  const merch = eurToCents(quoteEur);
  if (format === "digital") return merch;
  return merch + eurToCents(shippingEur);
}

export function parseRecipient(
  shipping: StripeShippingDetails | null,
  email: string | null,
  phone: string | null,
): OrderRecipient | null {
  if (!shipping?.name || !shipping.address) return null;
  const a = shipping.address;
  const name = shipping.name.trim();
  const line1 = (a.line1 ?? "").trim();
  const city = (a.city ?? "").trim();
  const postcode = (a.postal_code ?? "").trim();
  const countryCode = (a.country ?? "").trim().toUpperCase();
  if (!name || !line1 || !city || !postcode || !/^[A-Z]{2}$/.test(countryCode)) {
    return null;
  }
  return {
    name: name.slice(0, 128),
    line1: line1.slice(0, 128),
    line2: (a.line2 ?? "").trim().slice(0, 128),
    city: city.slice(0, 128),
    state: (a.state ?? "").trim().slice(0, 128),
    postcode: postcode.slice(0, 32),
    countryCode,
    email: email && email.includes("@") ? email.trim().slice(0, 254) : null,
    phone: phone ? phone.trim().slice(0, 32) : null,
  };
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
    existingRaw !== null
      ? parseOrderRecord(existingRaw)
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
    (record.reason === "awaiting-prodigi" ||
      isRetryableProdigiReason(record.reason))
  ) {
    const create = input.createOrder ?? createProdigiOrder;
    const format = record.format as PhysicalFormat;
    const size = record.size as PrintSize;
    const frame =
      record.frame === "" ? null : (record.frame as FrameFinish);
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
      await input.kv.put(record.sessionId, JSON.stringify(record));
      console.error(
        `paid order ${record.sessionId} unfulfilled: ${result.reason} (${result.message}) — needs a human refund or retry`,
      );
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

  await input.kv.put(record.sessionId, JSON.stringify(record));
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
  if (typeof row.terminal !== "boolean") return null;
  if (row.status !== "paid" && row.status !== "paid-unfulfilled") return null;
  if (!isOrderFormat(row.format)) return null;
  if (typeof row.photoSlug !== "string") return null;
  if (typeof row.size !== "string" || typeof row.frame !== "string") return null;
  if (!isEurAmount(row.quoteEur) || !isInt(row.amountTotal)) return null;
  if (row.currency !== "eur") return null;
  if (!(row.reason === null || typeof row.reason === "string")) return null;
  if (!(row.masterKey === null || typeof row.masterKey === "string")) return null;
  if (typeof row.updatedAt !== "string") return null;
  if (!(row.prodigiOrderId === null || typeof row.prodigiOrderId === "string")) {
    return null;
  }
  if (!(row.prodigiStage === null || typeof row.prodigiStage === "string")) {
    return null;
  }
  if (!(row.assetUrl === null || typeof row.assetUrl === "string")) return null;
  if (row.assetUrl !== null && !isSafeAssetUrl(row.assetUrl)) return null;
  const recipient = parseStoredRecipient(row.recipient);
  if (recipient === undefined) return null;

  if (row.status === "paid") {
    if (row.format === "digital") {
      const expectedKey = masterKeyForSlug(row.photoSlug);
      if (
        !expectedKey ||
        row.masterKey !== expectedKey ||
        row.prodigiOrderId !== null ||
        row.assetUrl !== null ||
        recipient !== null
      ) {
        return null;
      }
    } else {
      if (
        row.masterKey !== null ||
        typeof row.prodigiOrderId !== "string" ||
        !row.prodigiOrderId ||
        typeof row.assetUrl !== "string" ||
        !row.assetUrl ||
        recipient === null
      ) {
        return null;
      }
    }
  } else if (row.masterKey !== null) {
    return null;
  }

  return {
    v: 1,
    sessionId: row.sessionId,
    merchantReference: row.sessionId,
    terminal: row.terminal,
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
    recipient,
    prodigiOrderId: row.prodigiOrderId,
    prodigiStage: row.prodigiStage,
    assetUrl: row.assetUrl,
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
  const quoteEur = parseEurAmount(meta.quoteEur ?? meta.merchandiseEur);
  const photoSlug = typeof meta.photoSlug === "string" ? meta.photoSlug : "";
  const masterKey = masterKeyForSlug(photoSlug);
  const size = clip(meta.size);
  const frame = clip(meta.frame);
  const recipient = parseRecipient(
    input.shippingDetails,
    input.customerEmail,
    input.customerPhone,
  );

  const shell: Omit<OrderRecord, "format" | "status" | "reason"> = {
    v: 1,
    sessionId: input.sessionId,
    merchantReference: input.sessionId,
    terminal: true,
    photoSlug,
    size,
    frame,
    quoteEur: quoteEur ?? 0,
    amountTotal: isInt(input.amountTotal) ? input.amountTotal : 0,
    currency: "eur",
    updatedAt: input.now,
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
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

  const shippingEur =
    format === "digital" ? 0 : parseEurAmount(meta.shippingEur);
  // A digital order is always 0 above, so "no shipping quote" means one thing
  // only: a physical order whose metadata is incomplete.
  if (shippingEur === null) {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }

  const expected = expectedAmountCents(format, quoteEur, shippingEur);
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

  if (!isPrintSize(size) || (format === "framed" && !isFrameFinish(frame))) {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }
  if (format !== "framed" && frame !== "") {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }

  if (!recipient) {
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      reason: "missing-shipping",
    };
  }

  if (!input.prodigiKeyConfigured) {
    // Retryable, not terminal. This used to be written with the shell's
    // terminal:true and the reason "prodigi-key-unset", which made it
    // indistinguishable from a done order: the webhook answered 200, Stripe
    // never redelivered, and a customer who paid for a print got nothing with
    // no log line anywhere. A missing key is deployment config, fixable inside
    // Stripe's ~3-day redelivery window, and the address is already valid — so
    // keep it and let a redelivery place the order.
    return {
      ...shell,
      format,
      status: "paid-unfulfilled",
      terminal: false,
      reason: "prodigi-unconfigured",
      recipient,
    };
  }

  // Internal marker: fulfillCheckoutSession will call Prodigi then rewrite.
  return {
    ...shell,
    format,
    status: "paid-unfulfilled",
    reason: "awaiting-prodigi",
    recipient,
  };
}

function parseFormat(raw: string | undefined): PrintFormat | null {
  if (raw && (FORMATS as readonly string[]).includes(raw)) {
    return raw as PrintFormat;
  }
  return null;
}

function parseEurAmount(raw: string | undefined): number | null {
  if (!raw || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(raw)) return null;
  return Number(raw);
}

function clip(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, 64);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * A stored euro amount has at most two decimals.
 *
 * The previous check was `|value * 100 - eurToCents(value)| < 1e-6`, but
 * eurToCents IS Math.round(value * 100), so that only asserted "no precision
 * finer than ~1e-5" — it accepted 9.999999999999 and 15.000000001. The write
 * path (parseEurAmount) admits only 1-2 decimals, so the read guard has to
 * match it; the round-trip below compares against the value's own 2-decimal
 * rounding, which tolerates binary-float error like 0.1 while rejecting a
 * genuinely sub-cent fraction.
 */
function isEurAmount(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return false;
  }
  return Number(value.toFixed(2)) === value;
}

function isOrderFormat(value: unknown): value is OrderFormat {
  return (
    value === "unknown" ||
    (typeof value === "string" && (FORMATS as readonly string[]).includes(value))
  );
}

function isPrintSize(value: string): value is PrintSize {
  return (PRINT_SIZES as readonly string[]).includes(value);
}

function isFrameFinish(value: string): value is FrameFinish {
  return (FRAME_FINISHES as readonly string[]).includes(value);
}

function isSafeAssetUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  if (referencesMasters(url)) return false;
  // Allow same-origin placeholders and HMAC print-asset Worker URLs only.
  // Path-only checks would let https://evil.example/placeholders/… through.
  try {
    const parsed = new URL(url);
    const site = new URL(siteUrl());
    if (parsed.origin !== site.origin) return false;
    if (parsed.pathname.startsWith("/placeholders/")) return true;
    if (parsed.pathname === "/api/print-asset") return true;
    return false;
  } catch {
    return false;
  }
}

/** undefined = malformed; null = explicitly null */
function parseStoredRecipient(
  raw: unknown,
): OrderRecipient | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of [
    "name",
    "line1",
    "line2",
    "city",
    "state",
    "postcode",
    "countryCode",
  ] as const) {
    if (typeof r[key] !== "string") return undefined;
  }
  if (!(r.email === null || typeof r.email === "string")) return undefined;
  if (!(r.phone === null || typeof r.phone === "string")) return undefined;
  if (!/^[A-Z]{2}$/.test(r.countryCode as string)) return undefined;
  return {
    name: r.name as string,
    line1: r.line1 as string,
    line2: r.line2 as string,
    city: r.city as string,
    state: r.state as string,
    postcode: r.postcode as string,
    countryCode: r.countryCode as string,
    email: r.email as string | null,
    phone: r.phone as string | null,
  };
}

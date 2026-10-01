/**
 * Checkout fulfillment for ORDERS KV.
 * Digital: paid + masterKey for /api/download.
 * Physical: Prodigi order on payment; asset URL is HMAC /api/print-asset
 * (or placeholder). Masters never leave photos.ts / MASTERS binding.
 */

import {
  PHOTO_SLUG_PATTERN,
  masterKeyForSlug,
  readMasterObject,
  type MasterObject,
  type MastersBucket,
} from "./master-key";
import { referencesMasters } from "./master-guard";
import { ISO_ALPHA2_PATTERN } from "./ship-to-countries";
import { HTTPS_URL_PATTERN } from "./url-patterns";
import {
  createProdigiOrder,
  isRetryableProdigiReason,
  type CreateProdigiOrder,
  type OrderRecipient,
} from "./prodigi-order";
import {
  eurToCents,
  parseEurAmount,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "./pricing";
import {
  isFrameFinishValue,
  isPrintSize,
  isSellableFormat,
  type PhysicalFormat,
} from "./sku-map";
import { siteUrl } from "./stripe";

export type { PrintFormat };
export type OrderFormat = PrintFormat | "unknown";
export type OrderStatus =
  | "paid"
  | "paid-unfulfilled"
  /** Stripe money returned in full. Terminal: no download, no retry. */
  | "refunded"
  /** A cardholder dispute is open. Treated exactly like a refund. */
  | "disputed";

/**
 * The two statuses that take an order away from a customer for money reasons,
 * as opposed to our own failure to deliver.
 *
 * Distinct from `paid-unfulfilled` on purpose: there we owe the customer and
 * Stripe may redeliver, here the customer has been (or is claiming to have been)
 * made whole and re-serving the file would be the actual harm. Both end in
 * "not downloadable", so `isRevoked` — not a string comparison at each use — is
 * the single predicate for that.
 */
export type RevokedStatus = "refunded" | "disputed";

const REVOKED_STATUSES: ReadonlySet<string> = new Set<RevokedStatus>([
  "refunded",
  "disputed",
]);

export function isRevoked(status: OrderStatus): status is RevokedStatus {
  return REVOKED_STATUSES.has(status);
}

/**
 * Narrows an unknown value from KV to an OrderStatus. parseOrderRecord reads
 * untrusted JSON, so the status check has to survive not being a string —
 * a bare `isRevoked(row.status)` on a number is a Set lookup that quietly
 * returns false and lets a junk record through to be re-serialised later.
 */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" &&
    (value === "paid" ||
      value === "paid-unfulfilled" ||
      REVOKED_STATUSES.has(value))
  );
}

/**
 * Internal marker reason for a physical order that decideFulfillment has
 * accepted but that has not reached Prodigi yet. It is written once in
 * buildRecord and read once in the Prodigi trigger, and `reason` is
 * `string | null`, so a one-sided rename would type-check and strand every paid
 * print as paid-unfulfilled forever. Single-sourced so the two cannot drift.
 */
export const AWAITING_PRODIGI_REASON = "awaiting-prodigi";

/**
 * Truncation caps for the values parseRecipient forwards to Prodigi. Each
 * number is the one its own field can carry, not a shared "field length":
 * postcode and phone are both 32 today because postal and dial formats happen
 * to cap alike, and they are named separately so raising one does not silently
 * raise the other.
 *
 * The values are unchanged from the inline literals this replaces — this only
 * gives each a name at the site that owns it.
 */
const ADDRESS_LINE_MAX = 128;
const POSTCODE_MAX = 32;
const PHONE_MAX = 32;
const EMAIL_MAX = 254;

/**
 * The bound on a stored `size`/`frame` metadata string read back off ORDERS.
 * Distinct from the recipient caps above: this is a defensive bound on data
 * already narrowed to a PrintSize/FrameFinish, not a shipping-field limit.
 */
const STORED_ENUM_FIELD_MAX = 64;

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

export type { MasterObject, MastersBucket };

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
  if (!name || !line1 || !city || !postcode || !ISO_ALPHA2_PATTERN.test(countryCode)) {
    return null;
  }
  return {
    name: name.slice(0, ADDRESS_LINE_MAX),
    line1: line1.slice(0, ADDRESS_LINE_MAX),
    line2: (a.line2 ?? "").trim().slice(0, ADDRESS_LINE_MAX),
    city: city.slice(0, ADDRESS_LINE_MAX),
    state: (a.state ?? "").trim().slice(0, ADDRESS_LINE_MAX),
    postcode: postcode.slice(0, POSTCODE_MAX),
    countryCode,
    email:
      email && email.includes("@")
        ? email.trim().slice(0, EMAIL_MAX)
        : null,
    phone: phone ? phone.trim().slice(0, PHONE_MAX) : null,
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

/**
 * The single place an order is written to ORDERS, so no path can store a
 * paid-but-unfulfilled order without saying so.
 *
 * Before this, only the retryable Prodigi server failure logged; every other
 * unfulfilled outcome (bad metadata, unknown photo, amount mismatch, missing
 * shipping, and a terminal Prodigi client error) was written and answered 200
 * in silence. We keep the money, ship nothing, Stripe stops redelivering, and
 * there is no operator view over KV — so the order disappears until the
 * customer complains.
 *
 * `AWAITING_PRODIGI_REASON` is deliberately not alerted on: it is the internal
 * marker written by buildRecord on the way to Prodigi and rewritten by the same
 * call, not an outcome. Alerting on it would page for every healthy print.
 */
export function isUnfulfilledOutcome(record: OrderRecord): boolean {
  return (
    record.status === "paid-unfulfilled" &&
    record.reason !== AWAITING_PRODIGI_REASON
  );
}

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
    (record.reason === AWAITING_PRODIGI_REASON ||
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
  if (typeof row.status !== "string" || !isOrderStatus(row.status)) {
    return null;
  }
  if (!isOrderFormat(row.format)) return null;
  if (typeof row.photoSlug !== "string") return null;
  if (typeof row.size !== "string" || typeof row.frame !== "string") return null;
  if (!isEurAmount(row.quoteEur) || !isInt(row.amountTotal)) return null;
  if (row.currency !== "eur") return null;
  if (!isNullableString(row.reason)) return null;
  if (!isNullableString(row.masterKey)) return null;
  if (typeof row.updatedAt !== "string") return null;
  if (!isNullableString(row.prodigiOrderId)) {
    return null;
  }
  if (!isNullableString(row.prodigiStage)) {
    return null;
  }
  if (!isNullableString(row.assetUrl)) return null;
  if (row.assetUrl !== null && !isSafeAssetUrl(row.assetUrl)) return null;
  const recipient = parseStoredRecipient(row.recipient);
  if (recipient === undefined) return null;

  if (row.status === "paid" || isRevoked(row.status)) {
    // A revoked order is validated exactly like a paid one, with one
    // difference: masterKey must be null. That is the point of revoking —
    // the record keeps enough to identify and audit the order (and, for a
    // print, the Prodigi id needed to cancel it) but no longer names the file.
    if (row.format === "digital") {
      const expectedKey = masterKeyForSlug(row.photoSlug);
      if (
        !expectedKey ||
        (row.status === "paid" && row.masterKey !== expectedKey) ||
        (isRevoked(row.status) && row.masterKey !== null) ||
        row.prodigiOrderId !== null ||
        row.assetUrl !== null ||
        recipient !== null
      ) {
        return null;
      }
    } else if (isRevoked(row.status)) {
      // A revoked print is not held to the paid shape. A print revoked before
      // Prodigi ever accepted it (paid-unfulfilled, no order id, no asset url)
      // cannot satisfy those checks, and requiring them would make revocation
      // of such an order write a record this parser throws away — the order
      // would read as absent rather than revoked. What is present is already
      // type-checked above, so anything present is kept for the audit trail
      // and the Prodigi cancel; nothing is required.
      if (row.masterKey !== null) {
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

/**
 * What the customer should be shown for an order, as a closed set of cases the
 * success page renders one way each.
 *
 * Exists because the page and the download route were deciding this separately:
 * the page showed "Go to download" for every order regardless of format, so a
 * physical buyer got a link that 403s `not-a-digital-download` (#103). Deriving
 * both from one resolver is what keeps the page from offering something
 * resolveDownload will refuse.
 *
 * The cases are ordered to match resolveDownload's own checks, deliberately:
 * a physical order is reported as physical before any status question, so the
 * page cannot say "your download is processing" about an order that has no
 * download to process.
 */
export type OrderViewState =
  /** A physical order: being produced, no file to hand over. */
  | "physical"
  /** A digital order whose file is ready to download now. */
  | "digital-ready"
  /** A digital order still being fulfilled — the webhook has not finished. */
  | "digital-pending"
  /** Paid, but we could not deliver; the reason is worth showing, not the raw code. */
  | "digital-unavailable"
  /** Money returned or disputed: there is nothing to hand over and nothing to promise. */
  | "revoked";

export function orderViewState(order: OrderRecord): OrderViewState {
  if (order.format !== "digital") return "physical";
  if (isRevoked(order.status)) return "revoked";
  if (order.status === "paid" && order.masterKey) return "digital-ready";
  if (!order.terminal) return "digital-pending";
  return "digital-unavailable";
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
  const read = await readMasterObject(order.masterKey, masters);
  if (!read.ok) {
    return { kind: "json", status: read.status, body: { error: read.error } };
  }
  const object = read.object;

  // The catalog slug grammar, not a second copy of it: this used to inline the
  // same regex, so a slug the catalog rejected could still name the download.
  const filename = PHOTO_SLUG_PATTERN.test(order.photoSlug)
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

  if (!isPrintSize(size) || (format === "framed" && !isFrameFinishValue(frame))) {
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
    reason: AWAITING_PRODIGI_REASON,
    recipient,
  };
}

// The sku-map predicate, not this module's own copy of the list: parseFormat
// and isOrderFormat are the two guards that decide whether a stored order is
// fulfillable, so they have to read the same allow-list the order path writes
// from. `(FORMATS as string[]).includes(raw)` followed by a second
// `raw as PrintFormat` was the cast making the value valid rather than the
// check — the pattern sku-map already documents removing.
function parseFormat(raw: string | undefined): PrintFormat | null {
  return isSellableFormat(raw) ? raw : null;
}

function clip(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, STORED_ENUM_FIELD_MAX);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// A stored optional field is either a string or an explicit null — never
// undefined, never a number. Written out as `!(v === null || typeof v ===
// "string")` at seven call sites, where the double negative is what makes the
// narrowing work; a predicate states the rule once and narrows the same way.
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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
  return value === "unknown" || isSellableFormat(value);
}

function isSafeAssetUrl(url: string): boolean {
  if (!HTTPS_URL_PATTERN.test(url)) return false;
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

// Derived from the type, not spelled out: a hand-written list here is the
// same "names written twice" trap one hop up, and a field added to
// OrderRecipient would validate against nothing. The test asserts the derived
// list is exactly the seven non-nullable keys, so email/phone staying out of it
// is visible rather than implied.
type RecipientStringKey = {
  [K in keyof OrderRecipient]-?: [OrderRecipient[K]] extends [string]
    ? null extends OrderRecipient[K]
      ? never
      : K
    : never;
}[keyof OrderRecipient];

// Completeness is enforced, not just soundness: a key added to
// OrderRecipient that is missing here fails to compile, and a name that is not
// a key at all fails too. Annotated as an exhaustive record so both directions
// are checked; the object is what the loop iterates.
const RECIPIENT_STRING_KEYS: Record<RecipientStringKey, true> = {
  name: true,
  line1: true,
  line2: true,
  city: true,
  state: true,
  postcode: true,
  countryCode: true,
};

/** undefined = malformed; null = explicitly null */
function parseStoredRecipient(
  raw: unknown,
): OrderRecipient | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(RECIPIENT_STRING_KEYS) as RecipientStringKey[]) {
    if (typeof r[key] !== "string") return undefined;
  }
  if (!isNullableString(r.email)) return undefined;
  if (!isNullableString(r.phone)) return undefined;
  // The loop proved every key above is a string, but a computed key does not
  // carry that narrowing, so read them back through one typed view instead of
  // casting each field. email/phone need no cast: the predicate narrowed them.
  const s = r as Record<RecipientStringKey, string>;
  if (!ISO_ALPHA2_PATTERN.test(s.countryCode)) return undefined;
  return {
    name: s.name,
    line1: s.line1,
    line2: s.line2,
    city: s.city,
    state: s.state,
    postcode: s.postcode,
    countryCode: s.countryCode,
    email: r.email,
    phone: r.phone,
  };
}

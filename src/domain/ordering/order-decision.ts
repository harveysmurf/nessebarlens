/**
 * The pure interpreter for a paid Checkout Session.
 *
 * Everything here answers a question about an order — is this session ours, is
 * this stored row trustworthy, what should this record say, may this customer
 * download — with no KV, no Prodigi and no Stripe in reach. That is the whole
 * point of the split: the rules that decide *what should happen* are the rules
 * worth testing exhaustively, and they are only testable exhaustively if they
 * cannot reach for a binding.
 *
 * The effects live in fulfillment.ts, which imports this module and calls it.
 *
 * Digital: paid + masterKey for /api/download.
 * Physical: Prodigi order on payment; asset URL is HMAC /api/print-asset
 * (or placeholder). Masters never leave photos.ts / MASTERS binding.
 */

import { PHOTO_SLUG_PATTERN } from "../catalog/derivative-ladder";
import {
  masterKeyForSlug,
  readMasterObject,
  type MastersBucket,
} from "../catalog/master-key";
import { referencesMasters } from "../catalog/master-guard";
import { ISO_ALPHA2_PATTERN } from "../pricing/ship-to-countries";
import { HTTPS_URL_PATTERN } from "../pricing/url-patterns";
import type { OrderRecipient } from "./order-recipient";
import { eurToCents, parseEurAmount, type PrintFormat } from "../pricing/pricing";
import {
  isFrameFinishValue,
  isPhysicalFormat,
  isPrintSize,
  isSellableFormat,
  type PhysicalFormat,
} from "../pricing/sku-map";
import { isEmailKind, type EmailKind } from "./email";
import { isRetryableProdigiReason } from "./prodigi-policy";

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
 * The bound on a stored `size`/`frame` metadata string read back off the orders store.
 * Distinct from the recipient caps above: this is a defensive bound on data
 * already narrowed to a PrintSize/FrameFinish, not a shipping-field limit.
 */
const STORED_ENUM_FIELD_MAX = 64;

/**
 * Truncation caps for shipment fields persisted from a Prodigi fetch (#117).
 * Named separately so raising the carrier bound cannot silently raise the
 * tracking URL bound (and vice versa). Empty string is the absent spelling —
 * the parser never stores null inside a shipment entry.
 *
 * Exported because the callback builds the very entries this parser reads:
 * the fetch side and the parse side must clip to the same numbers, or an
 * upstream value longer than the parser's cap would be stored and then
 * silently truncated back on read.
 */
export const SHIPMENT_STATUS_MAX = 64;
export const SHIPMENT_CARRIER_MAX = 64;
export const SHIPMENT_TRACKING_NUMBER_MAX = 128;
export const SHIPMENT_TRACKING_URL_MAX = 512;
/** Hard ceiling on how many shipment rows one order keeps. */
export const SHIPMENTS_MAX = 16;

/**
 * One shipment mirrored from Prodigi's `order.shipments[]`. Strings only;
 * absent upstream fields become `""` so the stored shape stays uniform and
 * `parseOrderRecord` never has to distinguish null from missing.
 */
export type OrderShipment = {
  status: string;
  carrier: string;
  trackingUrl: string;
  trackingNumber: string;
};

/**
 * The fields every stored order carries, whatever its format. The format is
 * carried by the `kind` discriminant plus the format-specific fields, so a
 * reader that needs a physical size or a digital master key has to narrow on
 * `kind` first — no cast.
 */
export type OrderRecordCommon = {
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
  quoteEur: number;
  amountTotal: number;
  currency: "eur";
  reason: string | null;
  masterKey: string | null;
  prodigiOrderId: string | null;
  prodigiStage: string | null;
  /** HMAC /api/print-asset or public placeholder — never a MASTERS key/URL. */
  assetUrl: string | null;
  updatedAt: string;
  /**
   * When the row was first written. Distinct from `updatedAt` so a stuck-order
   * alert (#116) can age from the payment, not from the latest retry claim.
   * Indexed as `created_at` in D1; the column is never a second source of truth.
   */
  createdAt: string;
  /**
   * Optimistic-lock generation for D1 conditional writes (#116). Starts at 1
   * on `putOrder`; every `transitionOrder` bumps it. Callers pass the value
   * they just read as `fromAttempts` — two racers that both read `n` produce
   * one matching UPDATE and one zero-row loser.
   */
  attempts: number;
  /**
   * Shipments last fetched from Prodigi (#117). Empty when the order has none
   * yet (or is digital). Never trusted from a callback body — only from our
   * own GET of the Prodigi order.
   */
  shipments: OrderShipment[];
  /**
   * Email kinds already emitted for this order (#117). The claim that makes
   * "emitted once" true: a kind is appended in the same store write that
   * records the stage/shipments the mail is about, before `sendEmail` runs.
   */
  emailsSent: EmailKind[];
};

/** A paid or revocable digital order: no size, frame or shipping recipient. */
export type DigitalOrder = OrderRecordCommon & {
  kind: "digital";
  format: "digital";
  size: "";
  frame: "";
  recipient: null;
};

/**
 * A physical order. `size` and `frame` stay strings because a physical order
 * can be written paid-unfulfilled before the metadata is proven valid, and a
 * recipient is only present once the address passed `parseRecipient` — the
 * Prodigi trigger re-checks both before it calls the client.
 */
export type PhysicalOrder = OrderRecordCommon & {
  kind: "physical";
  format: PhysicalFormat;
  size: string;
  frame: string;
  recipient: OrderRecipient | null;
};

/**
 * A stored record whose `format` string is one we do not recognise. It keeps
 * the raw string so a future version can reclassify it without a migration:
 * collapsing it to "unknown" would throw away the one fact a reclassification
 * has to work from.
 */
export type UnknownOrder = OrderRecordCommon & {
  kind: "unknown";
  format: string;
  size: string;
  frame: string;
  recipient: OrderRecipient | null;
};

export type OrderRecord = DigitalOrder | PhysicalOrder | UnknownOrder;

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
  if (
    !name ||
    !line1 ||
    !city ||
    !postcode ||
    !ISO_ALPHA2_PATTERN.test(countryCode)
  ) {
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
      email && email.includes("@") ? email.trim().slice(0, EMAIL_MAX) : null,
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
 * The single place an order is written to the orders store, so no path can store a
 * paid-but-unfulfilled order without saying so.
 *
 * Every unfulfilled outcome (bad metadata, unknown photo, amount mismatch,
 * missing shipping, and a terminal Prodigi client error) is written and
 * answered 200. We keep the money, ship nothing, Stripe stops redelivering,
 * and there is no operator view over KV — so the order disappears until the
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

/**
 * The record a Prodigi failure leaves behind: same order, the failure's own
 * reason, and no Prodigi ids or asset (this attempt placed nothing). `terminal`
 * is derived from the reason, never inherited, so the two failure branches in
 * fulfillment.ts — the retryable `server|timeout|unconfigured` arm and the
 * terminal client arm — cannot disagree about what a stored reason means.
 *
 * Pure: the caller does the Prodigi call and the store write; this only decides
 * the shape of the record those effects persist.
 */
export function withProdigiFailure(
  record: OrderRecord,
  failure: { reason: string },
): OrderRecord {
  return {
    ...record,
    terminal: !isRetryableProdigiReason(failure.reason),
    reason: failure.reason,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
  };
}

/**
 * The record a placed Prodigi order leaves behind: finished, paid, and naming
 * the id, stage and asset the provider returned. From here a redelivery of the
 * same session is a plain duplicate.
 */
export function withProdigiSuccess(
  record: OrderRecord,
  result: { orderId: string; stage: string | null; assetUrl: string },
): OrderRecord {
  return {
    ...record,
    terminal: true,
    status: "paid",
    reason: null,
    masterKey: null,
    prodigiOrderId: result.orderId,
    prodigiStage: result.stage,
    assetUrl: result.assetUrl,
  };
}

/**
 * Whether a stored record is a redelivery we should try again rather than a
 * duplicate: still paid-unfulfilled, not terminal, and carrying a retryable
 * Prodigi reason. The single predicate the webhook uses to tell "Stripe is
 * retrying us" from "this order is done".
 */
export function shouldRetry(record: OrderRecord): boolean {
  return (
    record.status === "paid-unfulfilled" &&
    !record.terminal &&
    isRetryableProdigiReason(record.reason)
  );
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
  if (
    typeof row.sessionId !== "string" ||
    !isCheckoutSessionId(row.sessionId)
  ) {
    return null;
  }
  if (row.merchantReference !== row.sessionId) return null;
  if (typeof row.terminal !== "boolean") return null;
  if (typeof row.status !== "string" || !isOrderStatus(row.status)) {
    return null;
  }
  // The format must be a string; a string we do not recognise is not a
  // rejection — it is an UnknownOrder, so a future release can reclassify it
  // without a migration. A stored order becoming unreadable is data loss.
  if (typeof row.format !== "string") return null;
  if (typeof row.photoSlug !== "string") return null;
  if (typeof row.size !== "string" || typeof row.frame !== "string")
    return null;
  if (!isEurAmount(row.quoteEur) || !isInt(row.amountTotal)) return null;
  if (row.currency !== "eur") return null;
  if (!isNullableString(row.reason)) return null;
  if (!isNullableString(row.masterKey)) return null;
  if (typeof row.updatedAt !== "string") return null;
  // Pre-D1 fixtures and KV-era records may omit these; default rather than
  // reject so a migration or an old test seed still parses. New writes always
  // set both, and the D1 columns are the lock the store actually compares.
  const createdAt =
    typeof row.createdAt === "string" && row.createdAt.length > 0
      ? row.createdAt
      : row.updatedAt;
  const attempts =
    typeof row.attempts === "number" &&
    Number.isInteger(row.attempts) &&
    row.attempts >= 1
      ? row.attempts
      : 1;
  // Same lenient default as createdAt/attempts (#117): shipments and
  // emailsSent did not exist on older records. Rejecting a missing or
  // malformed value would turn every live paid order into "corrupt" the
  // moment this parser shipped — the worst possible failure for money we
  // already took. Absent or junk ⇒ `[]`; a well-formed entry is kept.
  const shipments = parseStoredShipments(row.shipments);
  const emailsSent = parseStoredEmailsSent(row.emailsSent);
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

  const kind: OrderRecord["kind"] =
    row.format === "digital"
      ? "digital"
      : isPhysicalFormat(row.format)
        ? "physical"
        : "unknown";

  if (row.status === "paid" || isRevoked(row.status)) {
    // A revoked order is validated exactly like a paid one, with one
    // difference: masterKey must be null. That is the point of revoking —
    // the record keeps enough to identify and audit the order (and, for a
    // print, the Prodigi id needed to cancel it) but no longer names the file.
    if (kind === "digital") {
      const expectedKey = masterKeyForSlug(row.photoSlug);
      if (
        !expectedKey ||
        (row.status === "paid" && row.masterKey !== expectedKey) ||
        (isRevoked(row.status) && row.masterKey !== null) ||
        row.prodigiOrderId !== null ||
        row.assetUrl !== null
      ) {
        return null;
      }
    } else if (kind === "physical") {
      if (isRevoked(row.status)) {
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
      } else if (
        row.masterKey !== null ||
        typeof row.prodigiOrderId !== "string" ||
        !row.prodigiOrderId ||
        typeof row.assetUrl !== "string" ||
        !row.assetUrl ||
        recipient === null
      ) {
        return null;
      }
    } else if (row.masterKey !== null) {
      // An unknown-format order is never downloadable, so it must not name a
      // file. Otherwise it is kept, untouched, for a human or a later version.
      return null;
    }
  } else if (row.masterKey !== null) {
    return null;
  }

  const common: OrderRecordCommon = {
    v: 1,
    sessionId: row.sessionId,
    merchantReference: row.sessionId,
    terminal: row.terminal,
    status: row.status,
    photoSlug: row.photoSlug,
    quoteEur: row.quoteEur,
    amountTotal: row.amountTotal,
    currency: "eur",
    reason: row.reason,
    masterKey: row.masterKey,
    prodigiOrderId: row.prodigiOrderId,
    prodigiStage: row.prodigiStage,
    assetUrl: row.assetUrl,
    updatedAt: row.updatedAt,
    createdAt,
    attempts,
    shipments,
    emailsSent,
  };

  if (row.format === "digital") {
    // A legacy digital record may still carry a size, a frame or a recipient;
    // those are dropped rather than stored, so the record stays readable.
    return {
      ...common,
      kind: "digital",
      format: "digital",
      size: "",
      frame: "",
      recipient: null,
    };
  }
  if (isPhysicalFormat(row.format)) {
    return {
      ...common,
      kind: "physical",
      format: row.format,
      size: row.size,
      frame: row.frame,
      recipient,
    };
  }
  return {
    ...common,
    kind: "unknown",
    format: row.format,
    size: row.size,
    frame: row.frame,
    recipient,
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
 * Physical orders never reach a digital state, so the page cannot say "your
 * download is processing" about an order that has no download to process. They
 * do get a status question, though: only a paid print is "being produced", and
 * a refunded or unfulfilled one must not say so.
 */
export type OrderViewState =
  /** A paid physical order that went to production: no file to hand over. */
  | "physical"
  /**
   * A physical order we took payment for but did not send to production (for
   * example missing-shipping). Must never read as "being produced".
   */
  | "physical-unfulfilled"
  /** A digital order whose file is ready to download now. */
  | "digital-ready"
  /** A digital order still being fulfilled — the webhook has not finished. */
  | "digital-pending"
  /** Paid, but we could not deliver; the reason is worth showing, not the raw code. */
  | "digital-unavailable"
  /** Money returned or disputed: there is nothing to hand over and nothing to promise. */
  | "revoked";

export function orderViewState(order: OrderRecord): OrderViewState {
  if (isRevoked(order.status)) return "revoked";
  if (order.kind !== "digital") {
    // paid-unfulfilled + AWAITING_PRODIGI_REASON is the ordinary in-flight
    // state between the webhook accepting the order and Prodigi answering; it
    // becomes "paid", or a failure reason, within seconds. Every other
    // unfulfilled reason is a real failure.
    const inFlight =
      order.status === "paid-unfulfilled" &&
      order.reason === AWAITING_PRODIGI_REASON;
    return order.status === "paid" || inFlight
      ? "physical"
      : "physical-unfulfilled";
  }
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

/**
 * The MASTERS bucket arrives as an argument rather than being read from
 * bindings here: the decision "may this order have its file, and under what
 * name" is pure, and only the object read is not.
 */
export async function resolveDownload(
  order: OrderRecord,
  masters: MastersBucket | undefined,
): Promise<DownloadResolution> {
  if (order.kind !== "digital") {
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

  // The catalog slug grammar, not a second copy of it: an inlined regex here
  // would let a slug the catalog rejected still name the download.
  const filename = PHOTO_SLUG_PATTERN.test(order.photoSlug)
    ? `${order.photoSlug}.jpg`
    : "download.jpg";

  return {
    kind: "stream",
    body: object.body,
    contentType: object.httpMetadata?.contentType || "image/jpeg",
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

  // Every field the three variants share. Status and reason are filled per
  // branch below; the format-specific fields (kind, format, size, frame,
  // recipient) come from the branch that knows the kind.
  const common: Omit<OrderRecordCommon, "status" | "reason"> = {
    v: 1,
    sessionId: input.sessionId,
    merchantReference: input.sessionId,
    terminal: true,
    photoSlug,
    quoteEur: quoteEur ?? 0,
    amountTotal: isInt(input.amountTotal) ? input.amountTotal : 0,
    currency: "eur",
    masterKey: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: input.now,
    createdAt: input.now,
    attempts: 1,
    // Every new record carries empty arrays so a reader never has to
    // special-case "field missing because this write predated #117".
    shipments: [],
    emailsSent: [],
  };

  // An absent or unrecognised format is an UnknownOrder with the "unknown"
  // sentinel — the only spelling of that sentinel, so a later version can
  // reclassify other strings without a migration.
  if (format === null) {
    return {
      ...common,
      kind: "unknown",
      format: "unknown",
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }

  if (format === "digital") {
    // A digital order never stores a size, frame or recipient — they are
    // dropped, so a digital record is byte-identical whether or not the
    // metadata carried the fields.
    if (quoteEur === null || !photoSlug) {
      return {
        ...common,
        kind: "digital",
        format: "digital",
        size: "",
        frame: "",
        recipient: null,
        status: "paid-unfulfilled",
        reason: "bad-metadata",
      };
    }
    if (!masterKey) {
      return {
        ...common,
        kind: "digital",
        format: "digital",
        size: "",
        frame: "",
        recipient: null,
        status: "paid-unfulfilled",
        reason: "unknown-photo",
      };
    }
    if (
      input.currency !== "eur" ||
      input.amountTotal !== expectedAmountCents("digital", quoteEur, 0)
    ) {
      return {
        ...common,
        kind: "digital",
        format: "digital",
        size: "",
        frame: "",
        recipient: null,
        status: "paid-unfulfilled",
        reason: "amount-mismatch",
      };
    }
    return {
      ...common,
      kind: "digital",
      format: "digital",
      size: "",
      frame: "",
      recipient: null,
      status: "paid",
      reason: null,
      masterKey,
    };
  }

  // `format` is a physical format from here down.
  if (quoteEur === null || !photoSlug) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }
  if (!masterKey) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "unknown-photo",
    };
  }

  const shippingEur = parseEurAmount(meta.shippingEur);
  // "no shipping quote" means one thing only: a physical order whose metadata
  // is incomplete.
  if (shippingEur === null) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }

  if (
    input.currency !== "eur" ||
    input.amountTotal !== expectedAmountCents(format, quoteEur, shippingEur)
  ) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "amount-mismatch",
    };
  }

  if (
    !isPrintSize(size) ||
    (format === "framed" && !isFrameFinishValue(frame))
  ) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }
  if (format !== "framed" && frame !== "") {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "bad-metadata",
    };
  }

  if (!recipient) {
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient: null,
      status: "paid-unfulfilled",
      reason: "missing-shipping",
    };
  }

  if (!input.prodigiKeyConfigured) {
    // Retryable, not terminal. Marking it terminal (the shell's `terminal:true`
    // with the reason "prodigi-key-unset") makes it indistinguishable from a
    // done order: the webhook answers 200, Stripe
    // never redelivers, and a customer who paid for a print gets nothing with
    // no log line anywhere. A missing key is deployment config, fixable inside
    // Stripe's ~3-day redelivery window, and the address is already valid — so
    // keep it and let a redelivery place the order.
    return {
      ...common,
      kind: "physical",
      format,
      size,
      frame,
      recipient,
      status: "paid-unfulfilled",
      terminal: false,
      reason: "prodigi-unconfigured",
    };
  }

  // Internal marker: fulfillCheckoutSession will call Prodigi then rewrite.
  return {
    ...common,
    kind: "physical",
    format,
    size,
    frame,
    recipient,
    status: "paid-unfulfilled",
    reason: AWAITING_PRODIGI_REASON,
  };
}

// The sku-map predicate, not this module's own copy of the list: parseFormat
// and the physical/digital split both read the same allow-list the order path
// writes from, so a format the catalog can order is accepted and nothing else.
// `(FORMATS as string[]).includes(raw)` followed by a second
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
 * The check is a round-trip against the value's own 2-decimal rounding, which
 * tolerates binary-float error like 0.1 while rejecting a genuinely sub-cent
 * fraction. It has to match the write path (parseEurAmount), which admits only
 * 1-2 decimals.
 */
function isEurAmount(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return false;
  }
  return Number(value.toFixed(2)) === value;
}

/**
 * Read-time shape check, deliberately not an origin check (#110).
 *
 * Comparing the origin to siteUrl() made every stored record unreadable the
 * moment NEXT_PUBLIC_SITE_URL moved — a domain move, or a preview reading a
 * production record — and an order that will not parse reads as corrupt, which
 * is the worst possible failure for a paid order. The signing payload is
 * `v1.{slug}.{exp}` (print-asset.ts), so a re-hosted URL still verifies; there
 * is nothing to re-sign.
 *
 * Same-origin is still enforced where it is knowable — at generation, where
 * the URL is built from siteUrl() — and pinned there by a test, because
 * buildProdigiOrderBody itself only checks the scheme.
 *
 * The residual exposure is that a tampered record can name any https origin.
 * assetUrl is never rendered: its only consumers are Prodigi (as the print
 * source) and the stored record, and tampering with it already requires KV
 * write access. Approved by @Architect in #110.
 */
function isSafeAssetUrl(url: string): boolean {
  if (!HTTPS_URL_PATTERN.test(url)) return false;
  if (referencesMasters(url)) return false;
  try {
    const parsed = new URL(url);
    // Only the shape this site serves. Path-only without this would let
    // https://evil.example/admin through. The public-placeholder path is gone:
    // the print asset is always the HMAC /api/print-asset (#245).
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

/**
 * Lenient shipment list: absent, non-array, or a hostile entry becomes `[]`
 * (or that entry is dropped), never a rejected record. A paid order that
 * cannot parse is worse than one that forgets a tracking number.
 */
function parseStoredShipments(raw: unknown): OrderShipment[] {
  if (!Array.isArray(raw)) return [];
  const out: OrderShipment[] = [];
  for (const entry of raw) {
    if (out.length >= SHIPMENTS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    out.push({
      status: clipShipmentField(s.status, SHIPMENT_STATUS_MAX),
      carrier: clipShipmentField(s.carrier, SHIPMENT_CARRIER_MAX),
      trackingUrl: clipShipmentField(s.trackingUrl, SHIPMENT_TRACKING_URL_MAX),
      trackingNumber: clipShipmentField(
        s.trackingNumber,
        SHIPMENT_TRACKING_NUMBER_MAX,
      ),
    });
  }
  return out;
}

function clipShipmentField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

/**
 * Lenient emailsSent list: absent or junk ⇒ `[]`; unknown kind strings are
 * dropped so a future kind written by a newer deploy does not make an older
 * parser reject the whole paid order.
 */
function parseStoredEmailsSent(raw: unknown): EmailKind[] {
  if (!Array.isArray(raw)) return [];
  const out: EmailKind[] = [];
  for (const entry of raw) {
    if (!isEmailKind(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/** undefined = malformed; null = explicitly null */
function parseStoredRecipient(raw: unknown): OrderRecipient | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(
    RECIPIENT_STRING_KEYS,
  ) as RecipientStringKey[]) {
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

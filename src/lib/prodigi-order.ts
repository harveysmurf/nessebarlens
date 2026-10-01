/**
 * Prodigi order creation. Host comes from PRODIGI_API_BASE (explicit per env).
 * Asset URLs are Worker HMAC /api/print-asset (or public placeholders) — never
 * raw MASTERS keys or r2.dev master paths.
 */

import { MASTERS_BUCKET, referencesMasters } from "./master-guard";
import { PHOTOS } from "./photos";
import type { FrameFinish, PrintSize } from "./pricing";
import {
  detailSuffix,
  PRODIGI_SHIPPING_METHOD,
} from "./prodigi-config";
import { prodigiApiKey, prodigiOrdersUrl } from "./config";
import { PLACEHOLDER_VERSION } from "./placeholder-photo";
import { signPrintAssetUrl } from "./print-asset";
import { resolveSku, type PhysicalFormat } from "./sku-map";
import { siteUrl } from "./config";
import { HTTPS_URL_PATTERN } from "./url-patterns";

export type OrderRecipient = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postcode: string;
  countryCode: string;
  email: string | null;
  phone: string | null;
};

export type ProdigiOrderRequest = {
  merchantReference: string;
  idempotencyKey: string;
  shippingMethod: typeof PRODIGI_SHIPPING_METHOD;
  recipient: {
    name: string;
    email?: string;
    phoneNumber?: string;
    address: {
      line1: string;
      line2?: string;
      postalOrZipCode: string;
      countryCode: string;
      townOrCity: string;
      stateOrCounty?: string;
    };
  };
  items: Array<{
    sku: string;
    copies: 1;
    sizing: "fillPrintArea";
    attributes: Record<string, string>;
    assets: Array<{ printArea: "default"; url: string }>;
  }>;
};

export type ProdigiOrderSuccess = {
  ok: true;
  orderId: string;
  stage: string | null;
  /** URL handed to Prodigi (HMAC print-asset or placeholder). */
  assetUrl: string;
};

/**
 * Why an order could not be created.
 *
 * The retry decision (`kind`) and the diagnosis (`reason`) are deliberately
 * separate axes. Auth and rate-limit failures share the same *retry* behaviour
 * but are different operational problems, so they get different reasons — the
 * stored record has to say which one it was, or "prodigi-error" tells nobody
 * whether to rotate a key or back off.
 */
export type ProdigiFailureReason =
  /** 401/403 — our key is wrong, revoked, or pointed at the wrong host. */
  | "prodigi-auth-error"
  /** 429 — we are being throttled; retrying later is correct. */
  | "prodigi-rate-limit"
  /** 5xx — Prodigi is down or erroring. */
  | "prodigi-unavailable"
  /** 4xx that is our fault and will never succeed on retry (bad request body). */
  | "prodigi-validation-error"
  /** 2xx with no order id in the body — a contract change, not a status code. */
  | "prodigi-error"
  /**
   * We hold paid money but cannot sign the master URL, so there is no asset to
   * send. Distinct from prodigi-unavailable: Prodigi was never contacted.
   */
  | "prodigi-asset-unconfigured"
  /**
   * This deployment has no usable Prodigi API key, or PRODIGI_API_BASE is not
   * an allowed host. Prodigi was never contacted. Retryable: the key is
   * deployment config, and a redeploy inside Stripe's redelivery window
   * (~3 days) is enough to place the order.
   */
  | "prodigi-unconfigured";

export type ProdigiOrderFailure = {
  ok: false;
  /**
   * "server" means retryable: the webhook answers 5xx so Stripe redelivers.
   *
   * 401/403/429 are "server", not "client": a "client" auth failure makes a
   * wrong sandbox key unrecoverable. The customer has paid, the record is
   * written, the webhook answers 200, and every later delivery hits the
   * duplicate branch — also 200. Stripe retries for ~3 days, so retrying a
   * genuinely permanent auth failure only buys the window to fix the key.
   */
  kind: "client" | "server";
  reason: ProdigiFailureReason;
  message: string;
  status: number | null;
};

/**
 * Map a Prodigi HTTP status to retry behaviour plus a diagnosable reason.
 *
 * Exported for the tests that pin the mapping; it is the whole policy in one
 * place, so "which statuses are terminal" has exactly one answer.
 */
export function classifyProdigiStatus(status: number): {
  kind: "client" | "server";
  reason: ProdigiFailureReason;
} {
  if (status === 401 || status === 403) {
    return { kind: "server", reason: "prodigi-auth-error" };
  }
  if (status === 429) {
    return { kind: "server", reason: "prodigi-rate-limit" };
  }
  if (status >= 500) {
    return { kind: "server", reason: "prodigi-unavailable" };
  }
  return { kind: "client", reason: "prodigi-validation-error" };
}

/**
 * Failures we still intend to retry, so the stored order stays eligible for a
 * redelivery instead of being short-circuited as a duplicate.
 */
const RETRYABLE_PRODIGI_REASONS: ReadonlySet<ProdigiFailureReason> =
  new Set<ProdigiFailureReason>([
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-asset-unconfigured",
    "prodigi-unconfigured",
  ]);

export function isRetryableProdigiReason(
  reason: string | null,
): reason is ProdigiFailureReason {
  return reason !== null && RETRYABLE_PRODIGI_REASONS.has(
    reason as ProdigiFailureReason,
  );
}

export type ProdigiOrderResult = ProdigiOrderSuccess | ProdigiOrderFailure;

export type CreateProdigiOrder = (input: {
  sessionId: string;
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  recipient: OrderRecipient;
  /** Override asset URL (tests). Default: signed print-asset or placeholder. */
  assetUrl?: string;
}) => Promise<ProdigiOrderResult>;

/**
 * Public stand-in. Still used for the Stripe session's display image, where a
 * low-resolution preview is the correct thing to show.
 */
export function placeholderAssetUrl(photoSlug: string): string {
  // The same `?v=` the gallery uses, from the same constant, so a placeholder
  // bump cannot leave the Stripe session image serving a stale CDN copy. The
  // version is imported rather than the function: that function returns null
  // for an unsafe slug, and this must keep returning a URL for whatever the
  // catalog handed us rather than throwing mid-order.
  return `${siteUrl()}/placeholders/${photoSlug}.jpg?v=${PLACEHOLDER_VERSION}`;
}

export function assertNoMasterLeak(value: unknown): void {
  const blob = JSON.stringify(value);
  if (blob.includes(MASTERS_BUCKET)) {
    throw new Error("master-leak: masters bucket referenced");
  }
  // The per-photo imageKey check comes first: every catalog imageKey starts
  // with prints/, so the generic marker below would reject the payload and this
  // loop's branch could never be reached from a test or from production.
  for (const photo of PHOTOS) {
    if (blob.includes(photo.imageKey)) {
      throw new Error(`master-leak: imageKey ${photo.imageKey}`);
    }
  }
  if (referencesMasters(blob)) {
    throw new Error("master-leak: prints/ master key path");
  }
}

export function buildProdigiOrderBody(input: {
  sessionId: string;
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  recipient: OrderRecipient;
  assetUrl?: string;
}): ProdigiOrderRequest {
  const entry = resolveSku(input.format, input.size, input.frame);
  const assetUrl = input.assetUrl ?? placeholderAssetUrl(input.photoSlug);
  if (!HTTPS_URL_PATTERN.test(assetUrl)) {
    throw new Error("asset url must be https");
  }
  if (referencesMasters(assetUrl)) {
    throw new Error("asset url must not point at masters");
  }

  const recipient: ProdigiOrderRequest["recipient"] = {
    name: input.recipient.name,
    address: {
      line1: input.recipient.line1,
      postalOrZipCode: input.recipient.postcode,
      countryCode: input.recipient.countryCode,
      townOrCity: input.recipient.city,
    },
  };
  if (input.recipient.line2) recipient.address.line2 = input.recipient.line2;
  if (input.recipient.state) {
    recipient.address.stateOrCounty = input.recipient.state;
  }
  if (input.recipient.email) recipient.email = input.recipient.email;
  if (input.recipient.phone) recipient.phoneNumber = input.recipient.phone;

  const body: ProdigiOrderRequest = {
    merchantReference: input.sessionId,
    idempotencyKey: input.sessionId,
    shippingMethod: PRODIGI_SHIPPING_METHOD,
    recipient,
    items: [
      {
        sku: entry.sku,
        copies: 1,
        sizing: "fillPrintArea",
        attributes: entry.attributes,
        assets: [{ printArea: "default", url: assetUrl }],
      },
    ],
  };
  assertNoMasterLeak(body);
  return body;
}

export const createProdigiOrder: CreateProdigiOrder = async (input) => {
  // The signed master URL for a paid physical order — or null if we cannot
  // sign, and there is no public-placeholder fallback. /api/checkout refuses to
  // take payment when signing is impossible, so reaching here with no secret
  // means the pre-payment guard did not hold (or the secret was removed
  // between payment and fulfillment). A placeholder here would ship a ~41KB,
  // 1600x1200 thumbnail to a customer who paid for a print and record the
  // order as fulfilled. Null lets us mark the order
  // `paid-unfulfilled/asset-unconfigured` and answer 5xx, so Stripe
  // redelivers and a human sees it.
  const assetUrl = input.assetUrl ?? (await signPrintAssetUrl(input.photoSlug));

  // Fail closed before we talk to Prodigi. Retryable, so the webhook answers
  // 5xx and Stripe redelivers once the secret is fixed.
  if (!assetUrl) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-asset-unconfigured",
      message: "print-asset signing is not configured",
      status: null,
    };
  }

  // Same fail-closed idea for the credential, and it has to be a *return*:
  // prodigiApiKey/prodigiOrdersUrl throw when PRODIGI_API_BASE is unset or is
  // not an allowed host, and a throw here escapes fulfillCheckoutSession to
  // the route's catch-all — which answers 500 "orders-kv-unavailable", a
  // diagnosis that points at the KV binding instead of the missing key, and
  // writes no record at all, so the paid order is invisible.
  let ordersUrl: string;
  let apiKey: string;
  try {
    ordersUrl = prodigiOrdersUrl();
    apiKey = prodigiApiKey();
  } catch (e) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unconfigured",
      message: e instanceof Error ? e.message : "prodigi-unconfigured",
      status: null,
    };
  }

  let body: ProdigiOrderRequest;
  try {
    body = buildProdigiOrderBody({ ...input, assetUrl });
  } catch (e) {
    return {
      ok: false,
      kind: "client",
      reason: "prodigi-validation-error",
      message: e instanceof Error ? e.message : "invalid-order-body",
      status: null,
    };
  }

  let res: Response;
  try {
    res = await fetch(ordersUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: e instanceof Error ? e.message : "network-error",
      status: null,
    };
  }

  // The body is read once, as text, before the status is judged, for the same
  // reason prodigi-quote.ts does it (#133): `res.json()` throws on an HTML
  // error page from the edge, the `catch {}` swallows that into `{}` (#135), and
  // the operator is left with a
  // bare "Prodigi order HTTP 502" that cannot be told apart from our own bad
  // request. Prodigi names the field it objected to, and that string is the only
  // thing distinguishing "fix our order body" from "check Prodigi's status page".
  //
  // An unreadable body (a dropped connection) is not an error here: the status
  // is still the useful half, and the parse below already tolerates a non-JSON
  // body by yielding no order id.
  const raw = await res.text().catch(() => "");

  if (!res.ok) {
    const { kind, reason } = classifyProdigiStatus(res.status);
    return {
      ok: false,
      kind,
      reason,
      message: `Prodigi order HTTP ${res.status}${detailSuffix(raw)}`,
      status: res.status,
    };
  }

  let data: {
    outcome?: string;
    order?: { id?: string; status?: { stage?: string } };
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    data = {};
  }

  const orderId = data.order?.id;
  if (typeof orderId !== "string" || !orderId) {
    return {
      ok: false,
      kind: "client",
      reason: "prodigi-error",
      message: "Prodigi order missing id",
      status: res.status,
    };
  }

  return {
    ok: true,
    orderId,
    stage:
      typeof data.order?.status?.stage === "string"
        ? data.order.status.stage
        : null,
    assetUrl,
  };
};

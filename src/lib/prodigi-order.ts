/**
 * Prodigi order creation. Host comes from PRODIGI_API_BASE (explicit per env).
 * Asset URLs are Worker HMAC /api/print-asset (or public placeholders) — never
 * raw MASTERS keys or r2.dev master paths.
 */

import { MASTERS_BUCKET, referencesMasters } from "./master-guard";
import { PHOTOS } from "./photos";
import type { FrameFinish, PrintSize } from "./pricing";
import {
  classifyProdigiStatus,
  detailSuffix,
  isProdigiTimeout,
  PRODIGI_ORDER_TIMEOUT_MS,
  PRODIGI_SHIPPING_METHOD,
  prodigiTimeoutSignal,
  prodigiUrl,
  type ProdigiFailureKind,
  type ProdigiFailureReason,
  type ProdigiResult,
} from "./prodigi-config";
import { prodigiConfig } from "./config";
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

/** The success payload of a Prodigi order, carried under `value` on the result. */
export type ProdigiOrderOk = {
  orderId: string;
  stage: string | null;
  /** URL handed to Prodigi (HMAC print-asset or placeholder). */
  assetUrl: string;
};

export type ProdigiOrderResult = ProdigiResult<ProdigiOrderOk>;

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
  // Same-origin at generation, which is where it is knowable: the read path
  // (parseOrderRecord) checks shape only, so a record written before a domain
  // move still parses. Here the URL comes from our own generators, so a foreign
  // origin can only be a caller bug — and it would otherwise be printed from.
  if (new URL(assetUrl).origin !== new URL(siteUrl()).origin) {
    throw new Error("asset url must be on the site origin");
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

function failure(
  kind: ProdigiFailureKind,
  reason: ProdigiFailureReason,
  message: string,
  status: number | null,
): ProdigiOrderResult {
  return { ok: false, kind, reason, message, status };
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
    return failure(
      "server",
      "prodigi-asset-unconfigured",
      "print-asset signing is not configured",
      null,
    );
  }

  // Same fail-closed idea for the credential, and it has to be a *return*: a
  // throw here would escape fulfillCheckoutSession to the route's catch-all,
  // which answers 500 "orders-store-unavailable" — a diagnosis pointing at the
  // store binding instead of the missing key, with no record written at all.
  const config = prodigiConfig();
  if (!config.ok) {
    return failure(
      "unconfigured",
      "prodigi-unconfigured",
      config.message,
      null,
    );
  }

  let body: ProdigiOrderRequest;
  try {
    body = buildProdigiOrderBody({ ...input, assetUrl });
  } catch (e) {
    return failure(
      "client",
      "prodigi-validation-error",
      e instanceof Error ? e.message : "invalid-order-body",
      null,
    );
  }

  // Bounded, so a hung Prodigi cannot outrun Stripe's response window (#104).
  // Below the deadline rather than at it: the answer has to reach Stripe as a
  // 5xx with time to spare, not at the moment it stops listening.
  const signal = prodigiTimeoutSignal(PRODIGI_ORDER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(prodigiUrl(config.base, "v4.0/orders"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.key,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // A timeout is retryable and says so: the order may well have been created
    // and the response lost, so the record keeps terminal:false and the webhook
    // answers 5xx. Redelivery re-sends the same idempotency key, which is what
    // makes retrying safe here rather than a way to place two prints.
    if (isProdigiTimeout(e, signal)) {
      return failure(
        "timeout",
        "prodigi-timeout",
        `Prodigi order timed out after ${PRODIGI_ORDER_TIMEOUT_MS}ms`,
        null,
      );
    }
    return failure(
      "server",
      "prodigi-unavailable",
      e instanceof Error ? e.message : "network-error",
      null,
    );
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
  let readFailure: unknown = null;
  const raw = await res.text().then(
    (text) => text,
    (e: unknown) => {
      // The rejection is kept, not discarded: a runtime that rejects the body
      // read with a TimeoutError without marking the signal is diagnosable
      // only from the error, so the empty string stands in for a body we never
      // read while `readFailure` stands in for why.
      readFailure = e;
      return "";
    },
  );

  // The signal outlives the headers: a Prodigi that sends a 200 and then stalls
  // aborts mid-body-read, and the handler above turns that into an empty body.
  // An empty body with a healthy status is indistinguishable from "success with
  // no order id" — a terminal path — so the abort has to be ruled out here, while
  // the order may already exist at Prodigi. Retryable, for the same reason the
  // fetch-level abort is: re-sending the same idempotency key is what makes the
  // second attempt safe.
  //
  // Checked before the status guard because a mid-read abort is a worse fact
  // than whatever status arrived with it. An aborted body with a non-2xx status
  // is still prodigi-timeout: the status is the truncated remnant, not an answer.
  if (isProdigiTimeout(readFailure, signal)) {
    return failure(
      "timeout",
      "prodigi-timeout",
      `Prodigi order timed out after ${PRODIGI_ORDER_TIMEOUT_MS}ms`,
      res.status,
    );
  }

  if (!res.ok) {
    const { kind, reason } = classifyProdigiStatus(res.status);
    return failure(
      kind,
      reason,
      `Prodigi order HTTP ${res.status}${detailSuffix(raw)}`,
      res.status,
    );
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
    return failure(
      "client",
      "prodigi-error",
      "Prodigi order missing id",
      res.status,
    );
  }

  return {
    ok: true,
    value: {
      orderId,
      stage:
        typeof data.order?.status?.stage === "string"
          ? data.order.status.stage
          : null,
      assetUrl,
    },
  };
};

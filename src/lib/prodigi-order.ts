/**
 * Prodigi order creation. Host comes from PRODIGI_API_BASE (explicit per env).
 * Asset URLs are Worker HMAC /api/print-asset — never raw MASTERS keys or
 * r2.dev master paths. The public-placeholder alternative is gone (#245).
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
  type ProdigiResult,
} from "./prodigi-config";
import type { ProdigiFailureReason } from "./prodigi-policy";
import { prodigiConfig, prodigiWebhookToken } from "./config";
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
  /**
   * Where Prodigi posts CloudEvents for this order (#117). Same origin as
   * the site — derived from siteUrl(), never a second env var — and carrying
   * `?token=` because the route authenticates on it. Absent when
   * PRODIGI_WEBHOOK_TOKEN is unset: a URL without the token would only ever
   * be answered 401/503, so sending none is more honest than sending it.
   */
  callbackUrl?: string;
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
  /**
   * The URL Prodigi actually holds — the HMAC print-asset or placeholder we
   * sent, or, on an adopted order (#193), the one read back from Prodigi. Never
   * the locally-built value when the order was not ours to build.
   */
  assetUrl: string;
  /**
   * True when Prodigi answered `AlreadyExists` and this order adopted the one
   * already there (#193). Carried so the record and the log can say the order
   * was reused, not created.
   */
  reusedExisting?: boolean;
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
 * Hosts where the Prodigi idempotency key stays the bare session id (#193).
 *
 * Existing production orders must keep their key: re-keying production would
 * make every in-flight retry place a *second* print for a payment, which is the
 * exact harm the idempotency key exists to prevent. Staging, local dev and any
 * future host get a namespaced key so a shared Prodigi sandbox namespace cannot
 * collide them with production.
 */
const PRODUCTION_HOSTS = new Set(["nessebarlens.com", "www.nessebarlens.com"]);

/**
 * The idempotency key for a session: bare on production, `host:session`
 * everywhere else.
 *
 * `merchantReference` stays the bare session id on purpose — it is the value a
 * human reads in the Prodigi dashboard and in `npm run orders`, and namespacing
 * it would put a hostname in front of every order reference.
 */
export function prodigiIdempotencyKey(
  sessionId: string,
  origin: string = siteUrl(),
): string {
  const host = new URL(origin).host;
  if (PRODUCTION_HOSTS.has(host)) return sessionId;
  return `${host}:${sessionId}`;
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
  /** The HMAC /api/print-asset URL Prodigi fetches. Required: there is no
   * public-placeholder fallback anymore (#245). */
  assetUrl: string;
  /** PRODIGI_WEBHOOK_TOKEN. Unset or blank ⇒ the body carries no callbackUrl. */
  webhookToken?: string;
}): ProdigiOrderRequest {
  const entry = resolveSku(input.format, input.size, input.frame);
  const assetUrl = input.assetUrl;
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

  // Same-origin callback as the asset URL: siteUrl() is the one public
  // origin. Prodigi posts CloudEvents here and signs nothing, so the route
  // authenticates on `?token=` in the registered URL (f24bf9f); a URL without
  // it is rejected 401 and every callback is lost.
  //
  // No token means no callbackUrl, not a failed order. The route answers 503
  // when it is unconfigured too, so the callback could not be accepted either
  // way, and refusing a paid order over a status feed would trade a customer's
  // print for a notification. The reconciler still polls Prodigi for orders
  // that never hear back, and the deploy scripts make the token a hard
  // requirement in production. The token itself is never logged: only the
  // fact that it was absent is.
  //
  // No origin check: the url is built from siteUrl() below, so its origin is
  // siteUrl()'s by construction. The parse is the check that has teeth: it
  // throws for a siteUrl() that is not a URL.
  const token = input.webhookToken?.trim();
  let callbackUrl: string | undefined;
  if (token) {
    callbackUrl = `${siteUrl()}/api/webhooks/prodigi?token=${encodeURIComponent(token)}`;
    new URL(callbackUrl);
  } else {
    console.warn(
      "prodigi order has no callbackUrl: PRODIGI_WEBHOOK_TOKEN is missing or empty",
    );
  }

  const body: ProdigiOrderRequest = {
    merchantReference: input.sessionId,
    // Namespaced off production (#193): staging and local share Prodigi's
    // sandbox namespace with us, and an unprefixed key let the first deployment
    // to POST define the order — asset URL and callback URL — for everyone.
    idempotencyKey: prodigiIdempotencyKey(input.sessionId),
    shippingMethod: PRODIGI_SHIPPING_METHOD,
    ...(callbackUrl ? { callbackUrl } : {}),
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

/** The origin of a URL, or null when it is absent or unparseable. Log-only. */
function originOf(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function failure(
  kind: ProdigiFailureKind,
  reason: ProdigiFailureReason,
  message: string,
  status: number | null,
): ProdigiOrderResult {
  return { ok: false, kind, reason, message, status };
}

/** What `GET /v4.0/orders/{id}` can tell us about an order we did not build. */
export type ExistingProdigiOrder = {
  id: string;
  stage: string | null;
  callbackUrl: string | null;
  assetUrl: string | null;
};

/**
 * Read back an order Prodigi already holds (#193).
 *
 * `AlreadyExists` carries only an `id` — no `status`, no `items` — so a caller
 * that only looks at the POST response cannot know what it adopted. That is the
 * bug: the record claimed our signed asset URL and a non-null stage for an order
 * whose callbackUrl was null and whose asset was a production placeholder.
 */
async function fetchProdigiOrder(input: {
  base: string;
  key: string;
  orderId: string;
  signal: AbortSignal;
}): Promise<
  | { ok: true; order: ExistingProdigiOrder }
  | { ok: false; result: ProdigiOrderResult }
> {
  let res: Response;
  try {
    res = await fetch(prodigiUrl(input.base, `v4.0/orders/${input.orderId}`), {
      headers: { "X-API-Key": input.key },
      signal: input.signal,
    });
  } catch (e) {
    if (isProdigiTimeout(e, input.signal)) {
      return {
        ok: false,
        result: failure(
          "timeout",
          "prodigi-timeout",
          `Prodigi order lookup timed out after ${PRODIGI_ORDER_TIMEOUT_MS}ms`,
          null,
        ),
      };
    }
    return {
      ok: false,
      result: failure(
        "server",
        "prodigi-unavailable",
        e instanceof Error ? e.message : "network-error",
        null,
      ),
    };
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const { kind, reason } = classifyProdigiStatus(res.status);
    return {
      ok: false,
      result: failure(
        kind,
        reason,
        `Prodigi order lookup HTTP ${res.status}${detailSuffix(raw)}`,
        res.status,
      ),
    };
  }

  let data: {
    id?: string;
    callbackUrl?: string | null;
    status?: { stage?: string | null };
    items?: Array<{ assets?: Array<{ url?: string | null }> | null } | null>;
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    data = {};
  }

  const assetUrl =
    data.items?.[0]?.assets?.[0]?.url ?? null;
  return {
    ok: true,
    order: {
      id: typeof data.id === "string" ? data.id : input.orderId,
      stage:
        typeof data.status?.stage === "string" ? data.status.stage : null,
      callbackUrl:
        typeof data.callbackUrl === "string" && data.callbackUrl
          ? data.callbackUrl
          : null,
      assetUrl: typeof assetUrl === "string" && assetUrl ? assetUrl : null,
    },
  };
}

/**
 * Is an adopted order ours, or another deployment's?
 *
 * Our own build always sends an asset URL on the site origin and, whenever
 * `PRODIGI_WEBHOOK_TOKEN` is set, a callback URL on the same origin. So a
 * foreign order shows up as an asset on another origin, a callback on another
 * origin, or — the shape #193 actually found — no callback at all on an account
 * whose key is set, which can only be an order built before we sent one.
 *
 * The token check is what keeps this from crying wolf: with no token configured
 * we send no callback, so a missing callback proves nothing and we accept the
 * order.
 */
export function isForeignOrder(input: {
  existing: ExistingProdigiOrder;
  localAssetUrl: string;
  localCallbackUrl: string | undefined;
  origin: string;
}): boolean {
  const origin = new URL(input.origin).origin;
  const foreignUrl = (value: string | null) => {
    if (value === null) return false;
    try {
      return new URL(value).origin !== origin;
    } catch {
      // Unparseable is not ours to trust: Prodigi echoing something that is not
      // a URL is a contract change, and claiming success on it is the bug.
      return true;
    }
  };
  if (foreignUrl(input.existing.assetUrl)) return true;
  if (foreignUrl(input.existing.callbackUrl)) return true;
  if (input.localCallbackUrl && input.existing.callbackUrl === null) return true;
  // We signed an asset URL; the order we adopted has none we can see, so the
  // record would claim a URL Prodigi does not hold.
  return input.existing.assetUrl === null;
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
    body = buildProdigiOrderBody({
      ...input,
      assetUrl,
      webhookToken: prodigiWebhookToken(),
    });
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

  // Prodigi answered "this key already has an order" (#193). The order in hand
  // is not one we built, so nothing in the POST response — including our own
  // assetUrl — may be reported as what Prodigi holds. Read the real order.
  if (data.outcome === "AlreadyExists") {
    const looked = await fetchProdigiOrder({
      base: config.base,
      key: config.key,
      orderId,
      signal,
    });
    if (!looked.ok) return looked.result;
    const existing = looked.order;
    const localCallbackUrl = body.callbackUrl;
    if (
      isForeignOrder({
        existing,
        localAssetUrl: assetUrl,
        localCallbackUrl,
        origin: siteUrl(),
      })
    ) {
      // Structured, because this is the fact that needs a human: another
      // deployment holds the print for this payment. The detail names the
      // origins, the asset URL is not logged in full because it carries a
      // signature.
      console.error(
        JSON.stringify({
          event: "prodigi.order.foreign",
          sessionId: input.sessionId,
          orderId: existing.id,
          siteOrigin: new URL(siteUrl()).origin,
          assetOrigin: originOf(existing.assetUrl),
          callbackOrigin: originOf(existing.callbackUrl),
        }),
      );
      return failure(
        "client",
        "prodigi-order-foreign",
        `Prodigi already holds order ${existing.id} for this idempotency key, built on another origin`,
        res.status,
      );
    }
    console.warn(
      JSON.stringify({
        event: "prodigi.order.reused",
        sessionId: input.sessionId,
        orderId: existing.id,
        stage: existing.stage,
      }),
    );
    return {
      ok: true,
      value: {
        orderId: existing.id,
        stage: existing.stage,
        // Prodigi's asset URL, not ours: on an adopted order the two can differ
        // and the record must describe what Prodigi will actually print.
        assetUrl: existing.assetUrl ?? assetUrl,
        reusedExisting: true,
      },
    };
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

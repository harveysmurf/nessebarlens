import { NextResponse } from "next/server";
import { readJsonBody } from "@/infrastructure/config/json-body";
import { parseCheckoutBody } from "@/domain/ordering/checkout-body";
import { API_ERROR_CODES } from "@/domain/ordering/api-error-codes";
import { SESSION_ID_PARAM } from "@/domain/ordering/order-decision";
import {
  physicalSpecification,
  type PrintSpecification,
} from "@/domain/ordering/print-spec";
import {
  DEFAULT_SHIPPING_COUNTRY,
  type ShipToCountryCode,
} from "@/domain/pricing/ship-to-countries";
import { getPhoto } from "@/domain/catalog/photos";
import { offers } from "@/domain/catalog/print-offer";
import { assess } from "@/domain/catalog/print-eligibility";
import {
  findProduct,
  FRAMED_MOUNT_VALUES,
} from "@/domain/pricing/print-products";
import {
  DIGITAL_PRICE_EUR,
  type FrameFinish,
  type PrintSize,
} from "@/domain/pricing/pricing";
import type { FramedMount, PrintPaper } from "@/domain/pricing/sku-map";
import { webDerivativeUrls } from "@/infrastructure/media/derivatives";
import { prodigiFailureFrom } from "@/infrastructure/prodigi/prodigi-config";
import { canSignMasterAsset } from "@/application/fulfillment/print-asset";
import { isConfiguredSiteUrl, siteUrl } from "@/infrastructure/config/config";
import { assetUrlSigner, paymentGateway, printProvider } from "@/infrastructure/container";
import type { CheckoutIntent } from "@/application/checkout/payment-gateway";

/**
 * POST /api/checkout.
 *
 * The endpoint answers with a code, never with a sentence: the copy for a code
 * lives in the dictionary and is rendered by the client, in the reader's
 * language. This route is unauthenticated, so what it says over the wire is
 * what anyone can read — the reason a request failed goes to the log.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    console.error("checkout.malformed-body", body.error);
    return NextResponse.json(
      { code: API_ERROR_CODES.invalidRequest },
      { status: body.status },
    );
  }
  const raw = body.value;

  const parsed = parseCheckoutBody(raw);
  if ("error" in parsed) {
    // The parser's wording is our vocabulary — slugs, sizes, formats, mounts —
    // and none of it is the reader's business. It goes to the log.
    console.error("checkout.rejected-body", parsed.error);
    return NextResponse.json(
      { code: API_ERROR_CODES.invalidRequest },
      { status: 400 },
    );
  }

  const photo = getPhoto(parsed.photoSlug);
  if (!photo) {
    return NextResponse.json(
      { code: API_ERROR_CODES.unknownPhoto },
      { status: 404 },
    );
  }

  // Checked before anything with a cost attached — a Prodigi quote, a Stripe
  // session. Without the site url we cannot build the success_url or the signed
  // print-asset URL Prodigi fetches, so the order is unserviceable either way;
  // refusing here means the customer is never charged.
  if (!isConfiguredSiteUrl()) {
    return NextResponse.json(
      { code: API_ERROR_CODES.serviceUnconfigured },
      { status: 503 },
    );
  }

  const spec: PrintSpecification =
    parsed.format === "digital"
      ? { kind: "digital" }
      : physicalSpecification(
          parsed.format,
          parsed.size,
          parsed.frame ?? null,
          parsed.mount,
          parsed.paper,
        );
  if (!offers(photo.printOffer, spec)) {
    return NextResponse.json(
      { code: API_ERROR_CODES.optionUnavailable },
      { status: 400 },
    );
  }

  // The offer is the mounted view (#335), so an unmounted selection needs its
  // own eligibility check against this master: a size can be offered mounted
  // and not unmounted (bigger print area, different aspect). Enforced here as
  // well as in the configurator, because the body is unauthenticated input.
  if (
    parsed.format === "framed" &&
    parsed.mount === FRAMED_MOUNT_VALUES.none
  ) {
    const product = findProduct(
      "framed",
      parsed.size,
      FRAMED_MOUNT_VALUES.none,
      null,
    );
    if (!product || !assess(photo.master, product).verdict.eligible) {
      return NextResponse.json(
        { code: API_ERROR_CODES.optionUnavailable },
        { status: 400 },
      );
    }
  }

  const isPhysical = parsed.format !== "digital";
  let quoteEur: number;
  let shippingEur = 0;
  let sku = "";
  // The metadata strings for a physical order, "" for a digital one. A digital
  // body has no size/frame fields, so the strings are defaulted here rather
  // than read off the union (where they would not exist).
  let size = "";
  let frame = "";
  let mount = "";
  let paper = "";
  let destinationCountryCode: ShipToCountryCode | null = null;
  // The typed spec for the payment intent, set only in the physical arm (the
  // union narrows there without a cast; the metadata strings above stay the
  // wire-format values).
  let intentSize: PrintSize | null = null;
  let intentFrame: FrameFinish | null = null;
  let intentMount: FramedMount | null = null;
  let intentPaper: PrintPaper | null = null;

  if (parsed.format !== "digital") {
    // `parsed` is now the physical arm: size/frame/destinationCountryCode are
    // narrowed without a cast, and destinationCountryCode is already
    // ShipToCountryCode | null.
    destinationCountryCode =
      parsed.destinationCountryCode ?? DEFAULT_SHIPPING_COUNTRY;
    const result = await printProvider().quote({
      format: parsed.format,
      size: parsed.size,
      frame: parsed.frame,
      mount: parsed.mount,
      paper: parsed.paper,
      destinationCountryCode,
    });
    if (!result.ok) {
      // Same shape as the quote route's failure: full detail to the log, the
      // code to the caller (#107).
      const failure = prodigiFailureFrom(result);
      console.error("prodigi.checkout", failure.code, failure.detail);
      return NextResponse.json(
        { code: API_ERROR_CODES.pricingUnavailable },
        { status: failure.status },
      );
    }
    quoteEur = result.value.merchandiseEur;
    shippingEur = result.value.shippingEur;
    sku = result.value.sku;
    size = parsed.size;
    frame = parsed.frame ?? "";
    mount = parsed.mount ?? "";
    paper = parsed.paper ?? "";
    intentSize = parsed.size;
    intentFrame = parsed.frame ?? null;
    intentMount = parsed.mount;
    intentPaper = parsed.paper;

    // Fail closed before taking the money. A physical order is fulfilled from
    // an HMAC-signed /api/print-asset URL; without a usable
    // PRINT_ASSET_HMAC_SECRET we cannot sign one, and the fulfillment path
    // would otherwise fall back to the public ~41KB placeholder — the customer
    // pays for a 70x100 giclee and Prodigi receives a 1600x1200 thumbnail, with
    // nothing recording that it happened. Refusing here means the customer is
    // never charged, so there is no refund path to build.
    if (!(await canSignMasterAsset(photo.slug, assetUrlSigner()))) {
      return NextResponse.json(
        { code: API_ERROR_CODES.serviceUnconfigured },
        { status: 503 },
      );
    }
  } else {
    quoteEur = DIGITAL_PRICE_EUR;
  }

  const base = siteUrl();
  // The image Stripe shows is the photo's public web derivative — the same
  // 1500px JPEG the gallery serves. Omitted when the CDN base is unconfigured,
  // rather than pointing at a file that does not exist (#245).
  const previewImage = webDerivativeUrls(photo)?.src;

  const metadata: Record<string, string> = {
    photoSlug: photo.slug,
    format: parsed.format,
    size,
    frame,
    mount,
    paper,
    quoteEur: String(quoteEur),
  };
  // No merchandiseEur here. quoteEur is written unconditionally above and
  // holds the same number, so the second key was a duplicate that only ever
  // existed for physical orders. The read side in fulfillment.ts still falls
  // back to meta.merchandiseEur, and must keep doing: sessions created before
  // quoteEur was written unconditionally carry that key and nothing else.
  if (isPhysical && destinationCountryCode) {
    metadata.shippingEur = String(shippingEur);
    metadata.sku = sku;
    metadata.destinationCountryCode = destinationCountryCode;
  }

  // Everything the provider needs, in domain terms. The Stripe request shape
  // (line items, adaptive pricing, shipping options) is the adapter's job —
  // this route no longer names a `Stripe.*` type or builds a session inline.
  const intent: CheckoutIntent = {
    title: photo.title,
    format: parsed.format,
    size: intentSize,
    frame: intentFrame,
    mount: intentMount,
    paper: intentPaper,
    previewImage: previewImage ?? null,
    quoteEur,
    shippingEur,
    destinationCountryCode,
    successUrl: `${base}/checkout/success?${SESSION_ID_PARAM}={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/cancel?slug=${encodeURIComponent(photo.slug)}`,
    metadata,
  };

  const created = await paymentGateway().createCheckout(intent);
  if (!created.ok) {
    // The adapter logs the raw provider error itself, so the SDK's `code`
    // survives in the log without ever reaching this unauthenticated body.
    if (created.reason === "unconfigured") {
      return NextResponse.json(
        { code: API_ERROR_CODES.serviceUnconfigured },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { code: API_ERROR_CODES.checkoutUnavailable },
      { status: 502 },
    );
  }

  return NextResponse.json({
    url: created.value.url,
    sessionId: created.value.sessionId,
    quoteEur,
    ...(isPhysical
      ? { merchandiseEur: quoteEur, shippingEur, sku }
      : {}),
  });
}

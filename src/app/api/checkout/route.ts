import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/json-body";
import { parseCheckoutBody } from "@/lib/checkout-body";
import {
  DEFAULT_SHIPPING_COUNTRY,
  type ShipToCountryCode,
} from "@/lib/ship-to-countries";
import { getPhoto } from "@/lib/photos";
import {
  DIGITAL_PRICE_EUR,
  type FrameFinish,
  type PrintSize,
} from "@/lib/pricing";
import { webDerivativeUrls } from "@/lib/derivatives";
import { prodigiFailureFrom } from "@/lib/prodigi-config";
import { canSignMasterAsset } from "@/lib/print-asset";
import { isConfiguredSiteUrl, siteUrl } from "@/lib/config";
import { paymentGateway, printProvider } from "@/lib/container";
import type { CheckoutIntent } from "@/lib/payment-gateway";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const raw = body.value;

  const parsed = parseCheckoutBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const photo = getPhoto(parsed.photoSlug);
  if (!photo) {
    return NextResponse.json({ error: "Unknown photoSlug" }, { status: 404 });
  }

  // Checked before anything with a cost attached — a Prodigi quote, a Stripe
  // session. Without the site url we cannot build the success_url or the signed
  // print-asset URL Prodigi fetches, so the order is unserviceable either way;
  // refusing here means the customer is never charged.
  if (!isConfiguredSiteUrl()) {
    return NextResponse.json(
      { error: "Checkout is not configured" },
      { status: 503 },
    );
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
  let destinationCountryCode: ShipToCountryCode | null = null;
  // The typed spec for the payment intent, set only in the physical arm (the
  // union narrows there without a cast; the metadata strings above stay the
  // wire-format values).
  let intentSize: PrintSize | null = null;
  let intentFrame: FrameFinish | null = null;

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
      destinationCountryCode,
    });
    if (!result.ok) {
      // Same shape as the quote route's failure: full detail to the log, code
      // and safe copy to the caller (#107).
      const failure = prodigiFailureFrom(result);
      console.error("prodigi.checkout", failure.code, failure.detail);
      return NextResponse.json(
        { error: failure.error, code: failure.code },
        { status: failure.status },
      );
    }
    quoteEur = result.value.merchandiseEur;
    shippingEur = result.value.shippingEur;
    sku = result.value.sku;
    size = parsed.size;
    frame = parsed.frame ?? "";
    intentSize = parsed.size;
    intentFrame = parsed.frame ?? null;

    // Fail closed before taking the money. A physical order is fulfilled from
    // an HMAC-signed /api/print-asset URL; without a usable
    // PRINT_ASSET_HMAC_SECRET we cannot sign one, and the fulfillment path
    // would otherwise fall back to the public ~41KB placeholder — the customer
    // pays for a 70x100 giclee and Prodigi receives a 1600x1200 thumbnail, with
    // nothing recording that it happened. Refusing here means the customer is
    // never charged, so there is no refund path to build.
    if (!(await canSignMasterAsset(photo.slug))) {
      return NextResponse.json(
        { error: "Print fulfillment is not configured" },
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
    previewImage: previewImage ?? null,
    quoteEur,
    shippingEur,
    destinationCountryCode,
    successUrl: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/cancel?slug=${encodeURIComponent(photo.slug)}`,
    metadata,
  };

  const created = await paymentGateway().createCheckout(intent);
  if (!created.ok) {
    // The adapter logs the raw provider error itself, so the SDK's `code`
    // survives in the log without ever reaching this unauthenticated body.
    if (created.reason === "unconfigured") {
      return NextResponse.json(
        { error: "Stripe is not configured" },
        { status: 503 },
      );
    }
    if (created.reason === "no-url") {
      return NextResponse.json(
        { error: "Stripe session missing URL" },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "Could not create Checkout Session", code: "checkout-unavailable" },
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

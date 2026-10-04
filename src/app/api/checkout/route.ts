import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/json-body";
import { parseCheckoutBody } from "@/lib/checkout-body";
import {
  DEFAULT_SHIPPING_COUNTRY,
  type ShipToCountryCode,
} from "@/lib/ship-to-countries";
import { getPhoto } from "@/lib/photos";
import { DIGITAL_PRICE_EUR, eurToCents, formatLabel } from "@/lib/pricing";
import { placeholderAssetUrl } from "@/lib/prodigi-order";
import { quotePhysical } from "@/lib/prodigi-quote";
import { prodigiFailureFrom } from "@/lib/prodigi-config";
import { canSignMasterAsset } from "@/lib/print-asset";
import { getStripe } from "@/lib/stripe";
import { isConfiguredSiteUrl, siteUrl } from "@/lib/config";
import { postcodeCustomFields } from "@/lib/postcode";

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

  if (parsed.format !== "digital") {
    // `parsed` is now the physical arm: size/frame/destinationCountryCode are
    // narrowed without a cast, and destinationCountryCode is already
    // ShipToCountryCode | null.
    destinationCountryCode =
      parsed.destinationCountryCode ?? DEFAULT_SHIPPING_COUNTRY;
    const result = await quotePhysical({
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
  // The same helper the Prodigi order body uses, so the image Stripe shows
  // and the asset the order carries cannot drift apart.
  const placeholderImage = placeholderAssetUrl(photo.slug);

  let stripe;
  try {
    stripe = getStripe();
  } catch {
    return NextResponse.json(
      { error: "Stripe is not configured" },
      { status: 503 },
    );
  }

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

  const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
    mode: "payment",
    // Adaptive Pricing off, stated here rather than left to the dashboard
    // toggle. With it on, Stripe shows the buyer a converted local amount,
    // while `amount_total` on the session stays in the integration currency
    // (eur) — the behaviour the webhook's `amount-mismatch` check relies on.
    // That guarantee is an API-version property, so it is asserted in
    // tests/adaptive-pricing.test.mts and would fail loudly if the Stripe
    // SDK upgrade changed the version the amount semantics depend on.
    adaptive_pricing: { enabled: false },
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel?slug=${encodeURIComponent(photo.slug)}`,
    // The line item is built inline rather than from a Stripe price_… ID on
    // purpose. Every price here is per-photo and per-quote (a Prodigi quote
    // for the chosen format/size/frame/destination), so there is no fixed
    // catalogue to map onto a Price created in the dashboard. Stripe's
    // account-setup guide tells you to create a non-recurring product and
    // paste its price ID; that step does not apply to this route, and
    // adding one would create an object nothing reads. `mode: "payment"`
    // plus the returned `session.url` is the whole hosted-checkout flow.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: eurToCents(quoteEur),
          product_data: {
            name: `${photo.title} — ${formatLabel(parsed.format)}`,
            description: isPhysical
              ? `${size}${frame ? ` · ${frame} frame` : ""}`
              : "Digital high-resolution license",
            images: [placeholderImage],
          },
        },
      },
    ],
    metadata,
  };

  // Required postcode (#195). Stripe's own postal-code box is optional for BG,
  // so without this a customer can pay and the order can never reach Prodigi.
  sessionParams.custom_fields = postcodeCustomFields(isPhysical);

  if (isPhysical && destinationCountryCode) {
    // Lock Stripe address to the quoted destination so the fixed shipping
    // amount matches Prodigi's rate for that country.
    sessionParams.shipping_address_collection = {
      allowed_countries: [destinationCountryCode],
    };
    sessionParams.shipping_options = [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: eurToCents(shippingEur),
            currency: "eur",
          },
          display_name: "Shipping",
        },
      },
    ];
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create(sessionParams);
  } catch (e) {
    // The log, not the body, is where this stays diagnosable: the SDK's error
    // carries its own `code` (`api_key_invalid`, `account_inactive`, ...) and
    // the three causes stay apart here, where the log reader is us. It also
    // carries the message for a connection failure, where there is no code at
    // all. The object is logged whole rather than through a code-or-"unknown"
    // ternary: the SDK wraps anything fetch threw, so a throw that reached this
    // catch without a `code` property could not happen, and an arm for it would
    // be a fallback nothing can test.
    console.error("stripe.checkout.sessions.create", e);
    return NextResponse.json(
      { error: "Could not create Checkout Session", code: "checkout-unavailable" },
      { status: 502 },
    );
  }

  if (!session.url) {
    return NextResponse.json(
      { error: "Stripe session missing URL" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    url: session.url,
    sessionId: session.id,
    quoteEur,
    ...(isPhysical
      ? { merchandiseEur: quoteEur, shippingEur, sku }
      : {}),
  });
}

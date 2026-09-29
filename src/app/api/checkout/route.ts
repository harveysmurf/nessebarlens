import { NextResponse } from "next/server";
import { parseCheckoutBody } from "@/lib/checkout-body";
import {
  DEFAULT_SHIPPING_COUNTRY,
  type ShipToCountryCode,
} from "@/lib/ship-to-countries";
import { getPhoto } from "@/lib/photos";
import { DIGITAL_PRICE_EUR, eurToCents, formatLabel } from "@/lib/pricing";
import { placeholderAssetUrl } from "@/lib/prodigi-order";
import { quotePhysical } from "@/lib/prodigi-quote";
import { prodigiErrorStatus } from "@/lib/prodigi-config";
import { canSignMasterAsset } from "@/lib/print-asset";
import { getStripe, siteUrl } from "@/lib/stripe";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseCheckoutBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const photo = getPhoto(parsed.photoSlug);
  if (!photo) {
    return NextResponse.json({ error: "Unknown photoSlug" }, { status: 404 });
  }

  const isPhysical = parsed.format !== "digital";
  let quoteEur: number;
  let shippingEur = 0;
  let sku = "";
  let destinationCountryCode: ShipToCountryCode | null = null;

  if (isPhysical) {
    destinationCountryCode =
      (parsed.destinationCountryCode as ShipToCountryCode | null) ??
      DEFAULT_SHIPPING_COUNTRY;
    try {
      const quote = await quotePhysical({
        format: parsed.format as Exclude<typeof parsed.format, "digital">,
        size: parsed.size!,
        frame: parsed.frame,
        destinationCountryCode,
      });
      quoteEur = quote.merchandiseEur;
      shippingEur = quote.shippingEur;
      sku = quote.sku;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Quote failed";
      const status = prodigiErrorStatus(message);
      return NextResponse.json({ error: message }, { status });
    }

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
    size: parsed.size ?? "",
    frame: parsed.frame ?? "",
    quoteEur: String(quoteEur),
  };
  if (isPhysical && destinationCountryCode) {
    metadata.merchandiseEur = String(quoteEur);
    metadata.shippingEur = String(shippingEur);
    metadata.sku = sku;
    metadata.destinationCountryCode = destinationCountryCode;
  }

  const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
    mode: "payment",
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
              ? `${parsed.size}${parsed.frame ? ` · ${parsed.frame} frame` : ""}`
              : "Digital high-resolution license",
            images: [placeholderImage],
          },
        },
      },
    ],
    metadata,
  };

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
    // Surface Stripe's own error code in the response body. Without it a
    // 502 is indistinguishable between a key missing Checkout Sessions
    // write, an account not yet live, and a bad request — every one of which
    // was a guess we had to make from outside. The message stays generic;
    // the code is what identifies the cause, and it is not sensitive.
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code: unknown }).code)
        : "unknown";
    console.error("stripe.checkout.sessions.create", code, e);
    return NextResponse.json(
      { error: "Could not create Checkout Session", stripeCode: code },
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

import { NextResponse } from "next/server";
import { parseCheckoutBody } from "@/lib/checkout-body";
import {
  DEFAULT_SHIPPING_COUNTRY,
  type ShipToCountryCode,
} from "@/lib/ship-to-countries";
import { getPhoto } from "@/lib/photos";
import { DIGITAL_PRICE_EUR, eurToCents, formatLabel } from "@/lib/pricing";
import { quotePhysical } from "@/lib/prodigi-quote";
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
      const status = message.includes("API key") ? 503 : 502;
      return NextResponse.json({ error: message }, { status });
    }
  } else {
    quoteEur = DIGITAL_PRICE_EUR;
  }

  const base = siteUrl();
  const placeholderImage = `${base}/placeholders/${photo.slug}.jpg`;

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
    console.error("stripe.checkout.sessions.create", e);
    return NextResponse.json(
      { error: "Could not create Checkout Session" },
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

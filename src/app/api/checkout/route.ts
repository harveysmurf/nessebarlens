import { NextResponse } from "next/server";
import { parseCheckoutBody } from "@/lib/checkout-body";
import { EU_27_COUNTRY_CODES } from "@/lib/eu-countries";
import { getPhoto } from "@/lib/photos";
import {
  EU_FLAT_SHIPPING_CENTS,
  computeQuoteEur,
  formatLabel,
} from "@/lib/pricing";
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

  let quoteEur: number;
  try {
    quoteEur = computeQuoteEur({
      fromPriceEur: photo.fromPriceEur,
      format: parsed.format,
      size: parsed.size,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bad quote" },
      { status: 400 },
    );
  }

  const isPhysical = parsed.format !== "digital";
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

  const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
    mode: "payment",
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel?slug=${encodeURIComponent(photo.slug)}`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: quoteEur * 100,
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
    metadata: {
      photoSlug: photo.slug,
      format: parsed.format,
      size: parsed.size ?? "",
      frame: parsed.frame ?? "",
      quoteEur: String(quoteEur),
    },
  };

  if (isPhysical) {
    sessionParams.shipping_address_collection = {
      allowed_countries: [...EU_27_COUNTRY_CODES],
    };
    sessionParams.shipping_options = [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: EU_FLAT_SHIPPING_CENTS,
            currency: "eur",
          },
          display_name: "EU shipping",
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
  });
}

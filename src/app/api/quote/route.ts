import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/json-body";
import { parseQuoteBody } from "@/lib/checkout-body";
import { DEFAULT_SHIPPING_COUNTRY } from "@/lib/ship-to-countries";
import { quotePhysical } from "@/lib/prodigi-quote";
import { prodigiFailure } from "@/lib/prodigi-config";
import { readCachedQuote, writeCachedQuote } from "@/lib/quote-cache";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const raw = body.value;

  const parsed = parseQuoteBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const cacheKey = {
    format: parsed.format,
    size: parsed.size,
    frame: parsed.frame,
    destinationCountryCode:
      parsed.destinationCountryCode ?? DEFAULT_SHIPPING_COUNTRY,
  };

  // Served before any Prodigi call: this route is unauthenticated and shares
  // Prodigi's rate limit with checkout, so an unpriced repeat of the same
  // configuration must not reach upstream (#113).
  const cached = await readCachedQuote(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const quote = await quotePhysical(cacheKey);
    // Only the two public numbers are cached — sku and unitCostEur are ours.
    await writeCachedQuote(cacheKey, {
      merchandiseEur: quote.merchandiseEur,
      shippingEur: quote.shippingEur,
    });
    // Ship only what the browser prices with. quotePhysical also carries `sku`
    // and `unitCostEur`, and this route is unauthenticated — returning the
    // whole object handed any caller our exact wholesale cost for all nine
    // pinned SKUs, the SKU codes themselves, and the 1.2x multiplier, which is
    // the margin. Checkout reads `sku` from quotePhysical server-side, so
    // nothing downstream needs them over the wire.
    return NextResponse.json({
      merchandiseEur: quote.merchandiseEur,
      shippingEur: quote.shippingEur,
    });
  } catch (e) {
    // An unset key is a deployment problem, not a bad gateway: prodigiFailure
    // makes that 503-vs-502 call once, for both Prodigi routes.
    const failure = prodigiFailure(e);
    return NextResponse.json(
      { error: failure.error },
      { status: failure.status },
    );
  }
}

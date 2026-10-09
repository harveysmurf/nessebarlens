import { NextResponse } from "next/server";
import { readJsonBody } from "@/infrastructure/config/json-body";
import { parseQuoteBody } from "@/domain/ordering/checkout-body";
import { DEFAULT_SHIPPING_COUNTRY } from "@/domain/pricing/ship-to-countries";
import { quotePhysical } from "@/infrastructure/prodigi/prodigi-quote";
import { prodigiFailureFrom } from "@/infrastructure/prodigi/prodigi-config";
import { readCachedQuote, writeCachedQuote } from "@/application/checkout/quote-cache";

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

  const result = await quotePhysical(cacheKey);
  if (!result.ok) {
    // An unset key is a deployment problem, not a bad gateway: prodigiFailureFrom
    // makes that 503-vs-502 call once, for both Prodigi routes. The internal
    // message goes to the log and only the code and the safe copy go over the
    // wire — this route is unauthenticated (#107).
    const failure = prodigiFailureFrom(result);
    console.error("prodigi.quote", failure.code, failure.detail);
    return NextResponse.json(
      { error: failure.error, code: failure.code },
      { status: failure.status },
    );
  }
  const quote = result.value;

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
}

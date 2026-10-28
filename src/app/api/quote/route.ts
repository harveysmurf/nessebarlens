import { NextResponse } from "next/server";
import { readJsonBody } from "@/infrastructure/config/json-body";
import { parseQuoteBody } from "@/domain/ordering/checkout-body";
import { API_ERROR_CODES } from "@/domain/ordering/api-error-codes";
import { DEFAULT_SHIPPING_COUNTRY } from "@/domain/pricing/ship-to-countries";
import { quotePhysical } from "@/infrastructure/prodigi/prodigi-quote";
import { prodigiFailureFrom } from "@/infrastructure/prodigi/prodigi-config";
import { readCachedQuote, writeCachedQuote } from "@/application/checkout/quote-cache";

/**
 * POST /api/quote.
 *
 * The endpoint answers with a code, never with a sentence: the copy for a code
 * lives in the dictionary and is rendered by the client, in the reader's
 * language. This route is unauthenticated, so what it says over the wire is
 * what anyone can read — the reason a request failed goes to the log.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    console.error("quote.malformed-body", body.error);
    return NextResponse.json(
      { code: API_ERROR_CODES.invalidRequest },
      { status: body.status },
    );
  }
  const raw = body.value;

  const parsed = parseQuoteBody(raw);
  if ("error" in parsed) {
    // The parser's wording is our vocabulary — sizes, formats, mounts — and
    // none of it is the reader's business. It goes to the log.
    console.error("quote.rejected-body", parsed.error);
    return NextResponse.json(
      { code: API_ERROR_CODES.invalidRequest },
      { status: 400 },
    );
  }

  const cacheKey = {
    format: parsed.format,
    size: parsed.size,
    frame: parsed.frame,
    // The mount (#335) and the paper (#337) are part of the product key:
    // CFPM/CFP and FAP/HPR are different SKUs at different prices, so the cache
    // must not share their entries and the Prodigi quote has to carry both to
    // resolve the right one.
    mount: parsed.mount,
    paper: parsed.paper,
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
    // message goes to the log and only the code goes over the wire — this
    // route is unauthenticated (#107).
    const failure = prodigiFailureFrom(result);
    console.error("prodigi.quote", failure.code, failure.detail);
    return NextResponse.json(
      { code: API_ERROR_CODES.pricingUnavailable },
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
  // whole object handed any caller our exact wholesale cost for every
  // pinned SKU, the SKU codes themselves, and the 1.2x multiplier, which is
  // the margin. Checkout reads `sku` from quotePhysical server-side, so
  // nothing downstream needs them over the wire.
  return NextResponse.json({
    merchandiseEur: quote.merchandiseEur,
    shippingEur: quote.shippingEur,
  });
}

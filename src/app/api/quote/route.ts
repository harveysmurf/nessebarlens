import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/json-body";
import { parseQuoteBody } from "@/lib/checkout-body";
import { DEFAULT_SHIPPING_COUNTRY } from "@/lib/ship-to-countries";
import { quotePhysical } from "@/lib/prodigi-quote";
import { prodigiErrorStatus } from "@/lib/prodigi-config";

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

  try {
    const quote = await quotePhysical({
      format: parsed.format,
      size: parsed.size,
      frame: parsed.frame,
      destinationCountryCode:
        parsed.destinationCountryCode ?? DEFAULT_SHIPPING_COUNTRY,
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
    const message = e instanceof Error ? e.message : "Quote failed";
    // An unset key is a deployment problem, not a bad gateway.
    const status = prodigiErrorStatus(message);
    return NextResponse.json({ error: message }, { status });
  }
}

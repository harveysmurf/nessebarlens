import { NextResponse } from "next/server";
import { parseQuoteBody } from "@/lib/checkout-body";
import { DEFAULT_SHIPPING_COUNTRY } from "@/lib/ship-to-countries";
import { quotePhysical } from "@/lib/prodigi-quote";
import { isProdigiUnconfigured } from "@/lib/prodigi-config";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
    return NextResponse.json(quote);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Quote failed";
    // An unset key is a deployment problem, not a bad gateway.
    const status = isProdigiUnconfigured(message) ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

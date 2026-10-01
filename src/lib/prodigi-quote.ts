import { DEFAULT_SHIPPING_COUNTRY } from "./ship-to-countries";
import {
  merchandiseFromUnitCost,
  parseEurAmount,
  type FrameFinish,
  type PrintSize,
} from "./pricing";
import {
  detailSuffix,
  PRODIGI_SHIPPING_METHOD,
  prodigiApiKey,
  prodigiQuotesUrl,
} from "./prodigi-config";
import { resolveSku, type PhysicalFormat } from "./sku-map";

export type PhysicalQuote = {
  sku: string;
  unitCostEur: number;
  shippingEur: number;
  merchandiseEur: number;
};

/**
 * Prodigi's own message from a failed response, appended to ours.
 *
 * The reader itself lives in prodigi-config so the order path (#135) reports the
 * upstream reason the same way from the same code, rather than the two drifting.
 */

type ProdigiQuoteResponse = {
  quotes?: Array<{
    items?: Array<{ unitCost?: { amount?: string } }>;
    costSummary?: { shipping?: { amount?: string } };
  }>;
};

// The shared grammar caps the integer part at six digits, which the local copy
// of this check did not. A quote that large is not a real quote, and rejecting
// it here is the same answer the stored-record path already gave.
function requiredEurAmount(raw: string | undefined, label: string): number {
  const amount = parseEurAmount(raw);
  if (amount === null) {
    throw new Error(`Prodigi quote missing ${label}`);
  }
  return amount;
}

export async function quotePhysical(opts: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  destinationCountryCode?: string;
}): Promise<PhysicalQuote> {
  const entry = resolveSku(opts.format, opts.size, opts.frame ?? null);
  const destinationCountryCode =
    opts.destinationCountryCode?.trim() || DEFAULT_SHIPPING_COUNTRY;

  // The host and the key are read before the request for the same reason
  // createProdigiOrder does it: prodigiQuotesUrl/prodigiApiKey throw when
  // PRODIGI_API_BASE is unset or not allowlisted, and a throw inside the
  // fetch() argument list skips the try below entirely. The message still
  // reaches isProdigiUnconfigured, so the route answers 503 for a config
  // problem and 502 for Prodigi being unhealthy.
  const quotesUrl = prodigiQuotesUrl();
  const apiKey = prodigiApiKey();

  const res = await fetch(quotesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      shippingMethod: PRODIGI_SHIPPING_METHOD,
      destinationCountryCode,
      currencyCode: "EUR",
      items: [
        {
          sku: entry.sku,
          copies: 1,
          attributes: entry.attributes,
          assets: [{ printArea: "default" }],
        },
      ],
    }),
  });

  // The body is read once, before the status is judged, because a Prodigi error
  // names the field it objected to ("SKU GLOBAL-CAN-12X16 not found") and that
  // string was being thrown away. `Prodigi quote HTTP 400` alone cannot tell an
  // operator whether Prodigi is unwell or we sent a request it will never
  // accept, which is the whole difference between the 502 and 503 answers and
  // between "check Prodigi's status page" and "fix our SKU map".
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Prodigi quote HTTP ${res.status}${detailSuffix(raw)}`);
  }

  let data: ProdigiQuoteResponse;
  try {
    data = JSON.parse(raw) as ProdigiQuoteResponse;
  } catch {
    throw new Error("Prodigi quote returned invalid JSON");
  }

  const quote = data.quotes?.[0];
  if (!quote) {
    throw new Error("Prodigi quote missing quotes[0]");
  }

  const unitCostEur = requiredEurAmount(
    quote.items?.[0]?.unitCost?.amount,
    "unitCost",
  );
  const shippingEur = requiredEurAmount(
    quote.costSummary?.shipping?.amount,
    "shipping",
  );

  return {
    sku: entry.sku,
    unitCostEur,
    shippingEur,
    merchandiseEur: merchandiseFromUnitCost(unitCostEur),
  };
}

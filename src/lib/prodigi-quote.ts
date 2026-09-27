import { DEFAULT_SHIPPING_COUNTRY } from "./ship-to-countries";
import {
  merchandiseFromUnitCost,
  type FrameFinish,
  type PrintSize,
} from "./pricing";
import { resolveSku, type PhysicalFormat } from "./sku-map";

/** Default quote destination when the client omits destinationCountryCode. */
export const DEFAULT_DESTINATION_COUNTRY = DEFAULT_SHIPPING_COUNTRY;

const PRODIGI_QUOTE_URL = "https://api.sandbox.prodigi.com/v4.0/quotes";

export type PhysicalQuote = {
  sku: string;
  unitCostEur: number;
  shippingEur: number;
  merchandiseEur: number;
};

type ProdigiQuoteResponse = {
  quotes?: Array<{
    items?: Array<{ unitCost?: { amount?: string } }>;
    costSummary?: { shipping?: { amount?: string } };
  }>;
};

function prodigiApiKey(): string {
  const key =
    process.env.PRODIGI_SANDBOX_API_KEY || process.env.PRODIGI_API_KEY;
  if (!key) {
    throw new Error("Prodigi API key is not set");
  }
  return key;
}

function parseEurAmount(raw: string | undefined, label: string): number {
  if (!raw || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Prodigi quote missing ${label}`);
  }
  return Number(raw);
}

export async function quotePhysical(opts: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  destinationCountryCode?: string;
}): Promise<PhysicalQuote> {
  const entry = resolveSku(opts.format, opts.size, opts.frame ?? null);
  const destinationCountryCode =
    opts.destinationCountryCode?.trim() || DEFAULT_DESTINATION_COUNTRY;

  const res = await fetch(PRODIGI_QUOTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": prodigiApiKey(),
    },
    body: JSON.stringify({
      shippingMethod: "Budget",
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

  if (!res.ok) {
    throw new Error(`Prodigi quote HTTP ${res.status}`);
  }

  let data: ProdigiQuoteResponse;
  try {
    data = (await res.json()) as ProdigiQuoteResponse;
  } catch {
    throw new Error("Prodigi quote returned invalid JSON");
  }

  const quote = data.quotes?.[0];
  if (!quote) {
    throw new Error("Prodigi quote missing quotes[0]");
  }

  const unitCostEur = parseEurAmount(
    quote.items?.[0]?.unitCost?.amount,
    "unitCost",
  );
  const shippingEur = parseEurAmount(
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

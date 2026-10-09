import { DEFAULT_SHIPPING_COUNTRY } from "../../domain/pricing/ship-to-countries";
import {
  merchandiseFromUnitCost,
  parseEurAmount,
  type FrameFinish,
  type PrintSize,
} from "../../domain/pricing/pricing";
import {
  classifyProdigiStatus,
  detailSuffix,
  isProdigiTimeout,
  PRODIGI_QUOTE_TIMEOUT_MS,
  PRODIGI_SHIPPING_METHOD,
  prodigiTimeoutSignal,
  prodigiUrl,
  type ProdigiResult,
} from "./prodigi-config";
import { prodigiConfig } from "../config/config";
import { resolveSku, type PhysicalFormat } from "../../domain/pricing/sku-map";

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

export async function quotePhysical(opts: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  destinationCountryCode?: string;
}): Promise<ProdigiResult<PhysicalQuote>> {
  const entry = resolveSku(opts.format, opts.size, opts.frame ?? null);
  const destinationCountryCode =
    opts.destinationCountryCode?.trim() || DEFAULT_SHIPPING_COUNTRY;

  // The host and the key are read before the request for the same reason
  // createProdigiOrder does it: a configuration read that fails must become a
  // returned failure, not a throw that escapes the fetch. `prodigiConfig`
  // returns a tagged result, so an unconfigured deployment is a distinct kind
  // the route maps to 503 rather than a message it has to match.
  const config = prodigiConfig();
  if (!config.ok) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: "prodigi-unconfigured",
      message: config.message,
      status: null,
    };
  }

  // Bounded, so a hung Prodigi answers the customer's spinner with an error
  // instead of an open request (#104). The message says it timed out rather
  // than naming the deadline: a timeout is upstream slowness, and the 502 that
  // prodigiFailureFrom derives from it sends an operator to Prodigi's status
  // page, which is the right destination here.
  const signal = prodigiTimeoutSignal(PRODIGI_QUOTE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(prodigiUrl(config.base, "v4.0/quotes"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.key,
      },
      signal,
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
  } catch (e) {
    // A timeout and any other network failure both return rather than throw.
    // "Prodigi quote timed out" tells an operator to look at Prodigi's latency
    // while "fetch failed" tells them nothing about which deadline was hit.
    if (isProdigiTimeout(e, signal)) {
      return {
        ok: false,
        kind: "timeout",
        reason: "prodigi-timeout",
        message: "Prodigi quote timed out",
        status: null,
      };
    }
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: e instanceof Error ? e.message : "network-error",
      status: null,
    };
  }

  // The body is read once, before the status is judged, because a Prodigi error
  // names the field it objected to ("SKU GLOBAL-CAN-12X16 not found") and that
  // string was being thrown away. `Prodigi quote HTTP 400` alone cannot tell an
  // operator whether Prodigi is unwell or we sent a request it will never
  // accept, which is the whole difference between the 502 and 503 answers and
  // between "check Prodigi's status page" and "fix our SKU map".
  const raw = await res.text();

  if (!res.ok) {
    const { kind, reason } = classifyProdigiStatus(res.status);
    return {
      ok: false,
      kind,
      reason,
      message: `Prodigi quote HTTP ${res.status}${detailSuffix(raw)}`,
      status: res.status,
    };
  }

  let data: ProdigiQuoteResponse;
  try {
    data = JSON.parse(raw) as ProdigiQuoteResponse;
  } catch {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi quote returned invalid JSON",
      status: res.status,
    };
  }

  const quote = data.quotes?.[0];
  if (!quote) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi quote missing quotes[0]",
      status: res.status,
    };
  }

  // The shared amount grammar caps the integer part at six digits, so a quote
  // that large reads as missing — the same label as a field Prodigi did not
  // send, because both mean "this quote cannot be priced".
  const unitCostEur = parseEurAmount(quote.items?.[0]?.unitCost?.amount);
  if (unitCostEur === null) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi quote missing unitCost",
      status: res.status,
    };
  }
  const shippingEur = parseEurAmount(quote.costSummary?.shipping?.amount);
  if (shippingEur === null) {
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi quote missing shipping",
      status: res.status,
    };
  }

  return {
    ok: true,
    value: {
      sku: entry.sku,
      unitCostEur,
      shippingEur,
      merchandiseEur: merchandiseFromUnitCost(unitCostEur),
    },
  };
}

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
  PRODIGI_SHIPPING_METHOD,
  prodigiUrl,
} from "./prodigi-config";
import {
  isProdigiTimeout,
  PRODIGI_QUOTE_TIMEOUT_MS,
  prodigiTimeoutSignal,
} from "../../domain/ordering/prodigi-timeout";
import { prodigiCall } from "./prodigi-request";
import { PRODIGI_FAILURE_REASONS } from "../../domain/ordering/prodigi-policy";
import type { ProdigiResult } from "../../domain/ordering/prodigi-result";
import { prodigiConfig } from "../config/config";
import {
  resolveSku,
  type FramedMount,
  type PhysicalFormat,
  type PrintPaper,
} from "../../domain/pricing/sku-map";
import type { PhysicalQuote } from "../../domain/ordering/print-provider";

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
  /** Framed only (#335); required and null for the formats without one. */
  mount: FramedMount | null;
  /** Giclée only (#337); required and null for the formats without one. */
  paper: PrintPaper | null;
  destinationCountryCode?: string;
}): Promise<ProdigiResult<PhysicalQuote>> {
  const entry = resolveSku(
    opts.format,
    opts.size,
    opts.frame ?? null,
    opts.mount ?? null,
    opts.paper ?? null,
  );
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
      reason: PRODIGI_FAILURE_REASONS.unconfigured,
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

  const call = await prodigiCall(
    prodigiUrl(config.base, "v4.0/quotes"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.key,
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
    },
    signal,
    "Prodigi quote timed out",
  );
  if (!call.ok) {
    const failure = call.failure;
    return {
      ok: false,
      kind: failure.kind,
      reason: failure.reason,
      message: failure.message,
      status: null,
    };
  }
  const res = call.response;

  // The body is read once, before the status is judged, because a Prodigi error
  // names the field it objected to ("SKU GLOBAL-CAN-12X16 not found") and that
  // string was being thrown away. `Prodigi quote HTTP 400` alone cannot tell an
  // operator whether Prodigi is unwell or we sent a request it will never
  // accept, which is the whole difference between the 502 and 503 answers and
  // between "check Prodigi's status page" and "fix our SKU map".
  //
  // A read that rejects is a dropped connection, not a body, and it must not
  // escape: this function promises a `ProdigiResult`, and a rejection here
  // reached the route as a 500 for what is Prodigi's side of the wire. The
  // order adapter reads its body the same way, and the reason is kept rather
  // than discarded, so a body that never arrived can be named as such.
  let readFailure: unknown = null;
  const raw = await res.text().then(
    (text) => text,
    (e: unknown) => {
      readFailure = e;
      return "";
    },
  );

  // A mid-read abort is a worse fact than whatever status arrived with it:
  // the status is the truncated remnant, not an answer. The timeout is only
  // consulted when the read actually failed -- a signal that fires after a
  // good body was read says nothing about that body.
  if (readFailure !== null && isProdigiTimeout(readFailure, signal)) {
    return {
      ok: false,
      kind: "timeout",
      reason: PRODIGI_FAILURE_REASONS.timeout,
      message: "Prodigi quote timed out",
      status: res.status,
    };
  }

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
      reason: PRODIGI_FAILURE_REASONS.unavailable,
      message:
        readFailure === null
          ? "Prodigi quote returned invalid JSON"
          : "Prodigi quote body could not be read",
      status: res.status,
    };
  }

  const quote = data.quotes?.[0];
  if (!quote) {
    return {
      ok: false,
      kind: "server",
      reason: PRODIGI_FAILURE_REASONS.unavailable,
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
      reason: PRODIGI_FAILURE_REASONS.unavailable,
      message: "Prodigi quote missing unitCost",
      status: res.status,
    };
  }
  const shippingEur = parseEurAmount(quote.costSummary?.shipping?.amount);
  if (shippingEur === null) {
    return {
      ok: false,
      kind: "server",
      reason: PRODIGI_FAILURE_REASONS.unavailable,
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

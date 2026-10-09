/**
 * The print-provider port — domain-owned interfaces for producing physical prints.
 *
 * Moved from `infrastructure/prodigi/print-provider.ts` and
 * `infrastructure/prodigi/prodigi-order.ts` so the application layer can
 * depend on domain types rather than the Prodigi adapter. The adapter
 * (`prodigi-print-provider.ts`) maps its HTTP functions onto these signatures.
 */

import type { PrintSize, FrameFinish } from "../pricing/pricing";
import type { PhysicalFormat } from "../pricing/sku-map";
import type { ProdigiResult } from "./prodigi-result";
import type { OrderRecipient } from "./order-recipient";

/** Price a physical print for a destination. */
export type QuotePhysical = (opts: {
  format: PhysicalFormat;
  size: PrintSize;
  frame?: FrameFinish | null;
  destinationCountryCode?: string;
}) => Promise<ProdigiResult<PhysicalQuote>>;

/** The price breakdown a quote returns. */
export type PhysicalQuote = {
  sku: string;
  unitCostEur: number;
  shippingEur: number;
  merchandiseEur: number;
};

/** The success payload of a Prodigi order. */
export type ProdigiOrderOk = {
  orderId: string;
  stage: string | null;
  /**
   * The URL Prodigi actually holds — the HMAC print-asset URL we sent, or on
   * an adopted order (#193) the one read back. Never a locally-built placeholder.
   */
  assetUrl: string;
  /** True when Prodigi answered AlreadyExists and this order adopted the one already there. */
  reusedExisting?: boolean;
};

export type ProdigiOrderResult = ProdigiResult<ProdigiOrderOk>;

/** Place a physical order. `assetUrl` is required — the signer runs in application. */
export type CreateProdigiOrder = (input: {
  sessionId: string;
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  recipient: OrderRecipient;
  /**
   * The HMAC /api/print-asset URL Prodigi fetches. Required: the caller
   * (fulfillment) signs it before calling, so there is no placeholder fallback.
   */
  assetUrl: string;
}) => Promise<ProdigiOrderResult>;

/** The success/failure shape of a Prodigi cancellation. */
export type ProdigiCancelResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; reason: string; message: string };

export type CancelProdigiOrder = (input: {
  prodigiOrderId: string;
  sessionId: string;
}) => Promise<ProdigiCancelResult>;

/**
 * The print-provider port. The application calls these; the Prodigi adapter
 * implements them.
 */
export type PrintProvider = {
  /** Price a physical spec for a destination. */
  quote: QuotePhysical;
  /** Place a physical order (CreateProdigiOrder). */
  placeOrder: CreateProdigiOrder;
};

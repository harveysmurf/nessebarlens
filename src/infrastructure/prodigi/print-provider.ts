/**
 * The print-provider port adapter (#3, DDD).
 *
 * The checkout and fulfillment application code talks to this interface; the
 * Prodigi HTTP/SKU logic stays behind it in `prodigi-quote.ts` and
 * `prodigi-order.ts`. Both members reuse the exact functions those modules
 * already export, so this is a named seam rather than a reimplementation — a
 * fake provider in a test is just an object with these two fields.
 */

import { createProdigiOrder } from "./prodigi-order";
import { quotePhysical } from "./prodigi-quote";
import type { PrintProvider } from "../../domain/ordering/print-provider";

/** The Prodigi-backed provider. */
export function prodigiPrintProvider(): PrintProvider {
  return { quote: quotePhysical, placeOrder: createProdigiOrder };
}

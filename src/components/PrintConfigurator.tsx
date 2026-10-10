"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SHIPPING_COUNTRY,
  isShipToCountryCode,
  SHIP_TO_COUNTRIES,
  type ShipToCountryCode,
} from "@/domain/pricing/ship-to-countries";
import {
  DIGITAL_PRICE_EUR,
  formatLabel,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "@/domain/pricing/pricing";
import { checkoutRequest, quoteRequest } from "@/domain/ordering/request-bodies";
import {
  CONFIGURATOR_FRAMES,
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_FORMAT,
  DEFAULT_PRINT_SIZE,
  firstOfferedSize,
  offeredFormats,
  sizeOptions,
} from "@/domain/ordering/print-copy";
import type { Orientation } from "@/domain/catalog/master-facts";
import type { PrintOffer } from "@/domain/catalog/print-offer";
import {
  checkoutUrl,
  isLiveQuote,
  readJsonResponse,
  requestErrorMessage,
  type LiveQuote,
} from "@/application/checkout/api-payloads";
import { isFrameFinishValue, isPrintSize } from "@/domain/pricing/sku-map";

export function PrintConfigurator({
  photoSlug,
  title,
  offer,
  orientation,
}: {
  photoSlug: string;
  title: string;
  offer: PrintOffer;
  orientation: Orientation;
}) {
  // #302: only the formats this photo offers, digital always. The list is never
  // empty — digital is in it — so the opening selection always exists.
  const formats = offeredFormats(offer);
  const openingFormat = formats[0]?.id ?? DEFAULT_PRINT_FORMAT;
  const [format, setFormat] = useState<PrintFormat>(openingFormat);
  const [size, setSize] = useState<PrintSize>(
    firstOfferedSize(offer, openingFormat) ?? DEFAULT_PRINT_SIZE,
  );
  const [frame, setFrame] = useState<FrameFinish>(DEFAULT_FRAME_FINISH);
  const [destinationCountry, setDestinationCountry] =
    useState<ShipToCountryCode>(DEFAULT_SHIPPING_COUNTRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const isDigital = format === "digital";
  const isFramed = format === "framed";
  // #302: sizes come from the photo's offer, in table order, labelled for its
  // orientation. The component no longer names the size list itself.
  const sizes = sizeOptions(offer, format, orientation);

  useEffect(() => {
    if (isDigital) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const body = quoteRequest(format, size,
          frame,
          destinationCountry,
        );
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        // The quote payload arrives from the network, so it is read as unknown
        // and each field the UI consumes is checked before use. A cast here
        // would only assert that the values are numbers; Number.isFinite is
        // what keeps a NaN from rendering as €NaN at the two price labels.
        // The read tolerates a non-JSON body: the unguarded response parse
        // rejected on the HTML an edge 502 answers with, and that rejection
        // surfaced to the customer as "Unexpected token '<'".
        const data: unknown = await readJsonResponse(res);
        if (!res.ok) {
          throw new Error(requestErrorMessage(data, res.status, "Quote failed"));
        }
        if (!isLiveQuote(data)) {
          throw new Error("Quote failed");
        }
        setQuote({
          merchandiseEur: data.merchandiseEur,
          shippingEur: data.shippingEur,
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        setQuote(null);
        setQuoteError(e instanceof Error ? e.message : "Quote failed");
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [format, size, frame, destinationCountry, isDigital]);

  // The three selects validate with `isPrintSize` / `isFrameFinish` /
  // `isShipToCountryCode` rather than narrowing with `as`. A cast asserts; it
  // does not check, so any string a browser put in the option list would
  // become a catalog value. The option lists come from the same sku-map lists
  // the predicates read, so a value that fails here is a value the selector
  // could not have produced.
  function selectFormat(value: PrintFormat) {
    setFormat(value);
    if (value === "digital") {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    // The new format has its own offered sizes; open on its first, so the size
    // select never points at a size the format does not offer.
    const first = firstOfferedSize(offer, value);
    if (first) setSize(first);
  }

  function selectSize(value: string) {
    if (isPrintSize(value)) setSize(value);
  }

  function selectFrame(value: string) {
    if (isFrameFinishValue(value)) setFrame(value);
  }

  function selectDestination(value: string) {
    if (isShipToCountryCode(value)) setDestinationCountry(value);
  }

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const body = checkoutRequest(
        photoSlug,
        format,
        size,
        frame,
        destinationCountry,
      );

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await readJsonResponse(res);
      // The transport status is checked first so the server's own error string
      // is the message on every non-ok response, whatever the payload's `url`
      // happens to be.
      if (!res.ok) {
        throw new Error(
          requestErrorMessage(data, res.status, "Checkout failed"),
        );
      }
      const url = checkoutUrl(data);
      if (!url) {
        throw new Error("Checkout failed");
      }
      // The redirect target arrives from the API response, so it is treated as
      // untrusted: `checkoutUrl` has already refused anything that is not an
      // absolute https URL on the Stripe checkout origin, on the same
      // synchronous path, before the navigation happens.
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setBusy(false);
    }
  }

  const priceLabel = (() => {
    if (isDigital) return `€${DIGITAL_PRICE_EUR.toFixed(2)}`;
    if (quoteLoading) return "…";
    if (quote) return `€${quote.merchandiseEur.toFixed(2)}`;
    return "—";
  })();

  return (
    <div className="space-y-6">
      <div className="border-y border-stone-100 py-4 space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="text-xs uppercase tracking-wider text-stone-500">
            {isDigital ? "Price" : "Print"}
          </span>
          <span className="text-2xl font-serif text-stone-900 font-semibold">
            {priceLabel}
          </span>
        </div>
        {!isDigital && (
          <div className="flex justify-between items-baseline text-xs text-stone-500">
            <span>Shipping estimate</span>
            <span>
              {quoteLoading
                ? "…"
                : quote
                  ? `€${quote.shippingEur.toFixed(2)}`
                  : "—"}
            </span>
          </div>
        )}
        {quoteError && (
          <p className="text-[11px] text-red-700" role="alert">
            {quoteError}
          </p>
        )}
      </div>

      <div className="space-y-4 text-xs">
        <fieldset>
          <legend className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-2">
            Supported Prodigi Option
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {formats.map((f) => {
              const active = format === f.id;
              return (
                // A real radio input, visually hidden behind the label: the
                // group and "one is selected" semantics come from the browser
                // instead of a hand-rolled toggle button, and arrow-key
                // navigation works without extra key handling.
                <label
                  key={f.id}
                  htmlFor={`format-option-${f.id}`}
                  className={`p-3 rounded text-left transition-colors cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-stone-900 ${
                    active
                      ? "border-2 border-stone-900"
                      : "border border-stone-200 hover:border-stone-400"
                  }`}
                >
                  <input
                    id={`format-option-${f.id}`}
                    type="radio"
                    name="print-format"
                    value={f.id}
                    checked={active}
                    onChange={() => selectFormat(f.id)}
                    className="sr-only"
                  />
                  <div className="font-medium text-stone-900">{f.title}</div>
                  <div className="text-[10px] text-stone-400">
                    {f.sub}
                    {f.id === "digital" ? ` · €${DIGITAL_PRICE_EUR}` : ""}
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>

        {!isDigital && (
          <div>
            <label
              htmlFor="print-size"
              className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1"
            >
              Dimensions
            </label>
            <select
              id="print-size"
              value={size}
              onChange={(e) => selectSize(e.target.value)}
              className="w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {isFramed && (
          <div>
            <label
              htmlFor="frame-finish"
              className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1"
            >
              Frame Finish
            </label>
            <select
              id="frame-finish"
              value={frame}
              onChange={(e) => selectFrame(e.target.value)}
              className="w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              {CONFIGURATOR_FRAMES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!isDigital && (
          <div>
            <label
              htmlFor="shipping-country"
              className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1"
            >
              Ship to
            </label>
            <select
              id="shipping-country"
              value={destinationCountry}
              onChange={(e) => selectDestination(e.target.value)}
              className="w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              {SHIP_TO_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="pt-4">
          <button
            type="button"
            disabled={busy || (!isDigital && (!quote || quoteLoading))}
            onClick={checkout}
            className="w-full bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white font-medium py-3.5 px-4 rounded text-xs uppercase tracking-widest transition-all shadow-sm"
          >
            {busy ? "Opening Checkout…" : "Checkout with Stripe"}
          </button>
          <p className="text-[10px] text-center text-stone-400 mt-2">
            {isDigital
              ? "Secure payment · Download link after fulfillment"
              : "Secure payment · Live Prodigi shipping · Prodigi fulfillment"}
          </p>
          {error && (
            <p className="text-[11px] text-center text-red-700 mt-2" role="alert">
              {error}
            </p>
          )}
          <p className="sr-only">
            {title} — {formatLabel(format)}
          </p>
        </div>
      </div>
    </div>
  );
}

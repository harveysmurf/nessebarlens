"use client";

import { useEffect, useState } from "react";
import {
  DIGITAL_PRICE_EUR,
  formatLabel,
  sizeLabel,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "@/lib/pricing";

const FORMATS: {
  id: PrintFormat;
  title: string;
  sub: string;
}[] = [
  { id: "giclee", title: "Giclée Fine Art", sub: "Hahnemühle 308gsm" },
  { id: "framed", title: "Framed Print", sub: "Solid Wood Frame" },
  { id: "canvas", title: "Stretched Canvas", sub: "Cotton Canvas" },
  { id: "digital", title: "Digital Copy", sub: "Full Resolution JPG" },
];

const SIZES: PrintSize[] = ["30x40", "50x70", "70x100"];

const FRAMES: { id: FrameFinish; label: string }[] = [
  { id: "black", label: "Matte Black" },
  { id: "white", label: "Satin White" },
  { id: "brown", label: "Brown Wood" },
];

type LiveQuote = {
  merchandiseEur: number;
  shippingEur: number;
};

export function PrintConfigurator({
  photoSlug,
  title,
}: {
  photoSlug: string;
  title: string;
}) {
  const [format, setFormat] = useState<PrintFormat>("giclee");
  const [size, setSize] = useState<PrintSize>("50x70");
  const [frame, setFrame] = useState<FrameFinish>("black");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const isDigital = format === "digital";
  const isFramed = format === "framed";

  useEffect(() => {
    if (isDigital) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const body =
          format === "framed"
            ? { format, size, frame }
            : { format, size, frame: null };
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = (await res.json()) as LiveQuote & { error?: string };
        if (!res.ok) {
          throw new Error(data.error || "Quote failed");
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
  }, [format, size, frame, isDigital]);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const body =
        format === "digital"
          ? { photoSlug, format, size: null, frame: null }
          : format === "framed"
            ? { photoSlug, format, size, frame }
            : { photoSlug, format, size, frame: null };

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Checkout failed");
      }
      window.location.href = data.url;
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
        <div>
          <label className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-2">
            Supported Prodigi Option
          </label>
          <div className="grid grid-cols-2 gap-2">
            {FORMATS.map((f) => {
              const active = format === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFormat(f.id)}
                  className={`p-3 rounded text-left transition-colors ${
                    active
                      ? "border-2 border-stone-900"
                      : "border border-stone-200 hover:border-stone-400"
                  }`}
                >
                  <div className="font-medium text-stone-900">{f.title}</div>
                  <div className="text-[10px] text-stone-400">
                    {f.sub}
                    {f.id === "digital" ? ` · €${DIGITAL_PRICE_EUR}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {!isDigital && (
          <div>
            <label className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1">
              Dimensions
            </label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value as PrintSize)}
              className="w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none"
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {sizeLabel(s)}
                </option>
              ))}
            </select>
          </div>
        )}

        {isFramed && (
          <div>
            <label className="block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1">
              Frame Finish
            </label>
            <select
              value={frame}
              onChange={(e) => setFrame(e.target.value as FrameFinish)}
              className="w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none"
            >
              {FRAMES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
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

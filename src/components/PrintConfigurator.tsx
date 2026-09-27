"use client";

import { useMemo, useState } from "react";
import {
  DIGITAL_PRICE_EUR,
  FORMAT_ADD_EUR,
  computeQuoteEur,
  formatLabel,
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
  { id: "oak", label: "Natural Oak Wood" },
  { id: "black", label: "Matte Black Wood" },
  { id: "white", label: "Satin White Wood" },
];

function sizeOptionLabel(size: PrintSize): string {
  switch (size) {
    case "30x40":
      return '30 × 40 cm (12 × 16") — Standard';
    case "50x70":
      return '50 × 70 cm (20 × 28") — Medium (+€18)';
    case "70x100":
      return '70 × 100 cm (28 × 40") — Gallery (+€40)';
  }
}

export function PrintConfigurator({
  photoSlug,
  fromPriceEur,
  title,
}: {
  photoSlug: string;
  fromPriceEur: number;
  title: string;
}) {
  const [format, setFormat] = useState<PrintFormat>("giclee");
  const [size, setSize] = useState<PrintSize>("50x70");
  const [frame, setFrame] = useState<FrameFinish>("oak");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDigital = format === "digital";
  const isFramed = format === "framed";

  const quoteEur = useMemo(() => {
    try {
      return computeQuoteEur({
        fromPriceEur,
        format,
        size: isDigital ? null : size,
      });
    } catch {
      return fromPriceEur;
    }
  }, [fromPriceEur, format, size, isDigital]);

  const formatHint = (id: PrintFormat): string => {
    if (id === "digital") return `€${DIGITAL_PRICE_EUR}`;
    const add = FORMAT_ADD_EUR[id];
    const base = fromPriceEur + add;
    return `from €${base}`;
  };

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

  return (
    <div className="space-y-6">
      <div className="border-y border-stone-100 py-4 flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-wider text-stone-500">
          Estimated Price
        </span>
        <span className="text-2xl font-serif text-stone-900 font-semibold">
          €{quoteEur.toFixed(2)}
        </span>
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
                    {f.sub} · {formatHint(f.id)}
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
                  {sizeOptionLabel(s)}
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
            <p className="text-[10px] text-stone-400 mt-1">
              Finish does not change the quote.
            </p>
          </div>
        )}

        <div className="pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={checkout}
            className="w-full bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white font-medium py-3.5 px-4 rounded text-xs uppercase tracking-widest transition-all shadow-sm"
          >
            {busy ? "Opening Checkout…" : "Checkout with Stripe"}
          </button>
          <p className="text-[10px] text-center text-stone-400 mt-2">
            {isDigital
              ? "Secure payment · Download link after fulfillment"
              : "Secure payment · EU shipping collected at Checkout · Prodigi fulfillment"}
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

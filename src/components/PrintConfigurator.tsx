"use client";

import { useEffect, useState } from "react";
import {
  fieldControlClass,
  fieldHintClass,
  fieldLabelClass,
} from "./field-styles";
import { Button } from "@/components/Button";
import {
  DEFAULT_SHIPPING_COUNTRY,
  isShipToCountryCode,
  type ShipToCountry,
  type ShipToCountryCode,
} from "@/domain/pricing/ship-to-countries";
import {
  DIGITAL_PRICE_EUR,
  eurLabel,
  formatLabel,
  type PrintFormat,
} from "@/domain/pricing/pricing";
import type { Locale } from "@/domain/i18n/locale";
import type { ConfiguratorCopy } from "@/components/i18n/dictionaries";
import { checkoutRequest, quoteRequest } from "@/domain/ordering/request-bodies";
import {
  configuratorFrames,
  configuratorMounts,
  configuratorPapers,
  framedMountNote,
  masterResolutionLabel,
  offeredFormats,
  paperNote,
  sizeOptions,
} from "@/domain/ordering/print-copy";
import {
  withFormat,
  withFrame,
  withMount,
  withPaper,
  withSize,
  type PrintSelection,
} from "@/domain/ordering/print-selection";
import type { MasterFacts } from "@/domain/catalog/master-facts";
import { postJson } from "@/infrastructure/http/post-json";
import { track } from "@/analytics/track";
import { assess, SHAPE_MISMATCH_REASON } from "@/domain/catalog/print-eligibility";
import {
  findProduct,
  FRAMED_MOUNT_VALUES,
} from "@/domain/pricing/print-products";
import type { PrintOffer } from "@/domain/catalog/print-offer";
import {
  checkoutUrl,
  isQuotePayload,
  readJsonResponse,
  type QuotePayload,
} from "@/application/checkout/api-payloads";
import { failureCopy } from "@/domain/api/error-code";
import { isApiErrorCode } from "@/domain/ordering/api-error-codes";
import {
  isFrameFinishValue,
  isFramedMountValue,
  isPrintPaperValue,
  isPrintSize,
} from "@/domain/pricing/sku-map";

export function PrintConfigurator({
  photoSlug,
  title,
  offer,
  master,
  selection,
  onSelectionChange,
  locale,
  copy,
  countries,
}: {
  photoSlug: string;
  title: string;
  offer: PrintOffer;
  master: MasterFacts;
  selection: PrintSelection;
  onSelectionChange: (next: PrintSelection) => void;
  /** The locale of the page: the prices and the country names are written in it. */
  locale: Locale;
  /** The configurator's own words, in the page's language. */
  copy: ConfiguratorCopy;
  /**
   * The destination list, already named in the page's language.
   *
   * The server builds it: the names come from ICU, and the server's ICU and
   * the browser's are not the same version, so a name the client re-derived
   * could differ from the one the server sent and React would regenerate the
   * tree.
   */
  countries: ShipToCountry[];
}) {
  // The whole MasterFacts is passed in (#295/#325): the size labels read its
  // orientation and the Digital Copy reads its dimensions, both from the one
  // measured source rather than re-derived here.
  const orientation = master.orientation;
  const resolutionLabel = masterResolutionLabel(master);
  // #302: only the formats this photo offers, digital always. The list is never
  // empty — digital is in it — so the opening selection always exists.
  const formats = offeredFormats(offer, locale);
  // #326: the selection is owned by the parent (PrintDetail), so the preview
  // and the configurator read the same value. These are views of it.
  const { format, size, frame, mount, paper } = selection;
  const [destinationCountry, setDestinationCountry] =
    useState<ShipToCountryCode>(DEFAULT_SHIPPING_COUNTRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuotePayload | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const isDigital = format === "digital";
  const isFramed = format === "framed";
  const isGiclee = format === "giclee";
  // #302: sizes come from the photo's offer, in table order, labelled for its
  // orientation. The component no longer names the size list itself.
  const sizes = sizeOptions(offer, format, orientation, locale);

  // #335: the unmounted product is assessed against this master at the selected
  // size, so the configurator can offer No Mount exactly where it can be printed
  // and say why not otherwise. The offer stays mounted-based; this is the one
  // place the second mount is judged, and it never swaps the product silently.
  const noMountVerdict = isFramed
    ? assess(master, findProduct("framed", size, FRAMED_MOUNT_VALUES.none, null)!)
    : null;
  const noMountEligible = noMountVerdict?.verdict.eligible ?? false;
  const noMountReason =
    noMountVerdict && !noMountVerdict.verdict.eligible
      ? noMountVerdict.verdict.reason === SHAPE_MISMATCH_REASON
        ? copy.noMountShape
        : copy.noMountResolution
      : null;

  useEffect(() => {
    track("configurator_open");
  }, []);

  useEffect(() => {
    if (isDigital) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const body = quoteRequest(
          format,
          size,
          frame,
          destinationCountry,
          mount,
          paper,
        );
        const res = await postJson("/api/quote", body, {
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
          // The body carries a code; the copy for it is this page's, and a
          // body we cannot read falls back to the generic sentence.
          throw new Error(
            failureCopy(
              data,
              { isCode: isApiErrorCode, copy: copy.apiErrors },
              copy.quoteFailed,
            ),
          );
        }
        if (!isQuotePayload(data)) {
          throw new Error(copy.quoteFailed);
        }
        setQuote({
          merchandiseEur: data.merchandiseEur,
          shippingEur: data.shippingEur,
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        setQuote(null);
        setQuoteError(e instanceof Error ? e.message : copy.quoteFailed);
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    format,
    size,
    frame,
    mount,
    paper,
    destinationCountry,
    isDigital,
    copy.quoteFailed,
    copy.apiErrors,
  ]);

  // The three selects validate with `isPrintSize` / `isFrameFinish` /
  // `isShipToCountryCode` rather than narrowing with `as`. A cast asserts; it
  // does not check, so any string a browser put in the option list would
  // become a catalog value. The option lists come from the same sku-map lists
  // the predicates read, so a value that fails here is a value the selector
  // could not have produced.
  function selectFormat(value: PrintFormat) {
    // `withFormat` opens a physical format on its first offered size, so the
    // size select never points at a size the format does not offer.
    onSelectionChange(withFormat(selection, offer, value));
    if (value === "digital") {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
    }
  }

  function selectSize(value: string) {
    if (isPrintSize(value)) onSelectionChange(withSize(selection, value));
  }

  function selectFrame(value: string) {
    if (isFrameFinishValue(value)) onSelectionChange(withFrame(selection, value));
  }

  function selectMount(value: string) {
    // A disabled option cannot be chosen through the select, and the guard keeps
    // a value the selector could not produce from ever becoming the selection.
    if (isFramedMountValue(value) && (value === FRAMED_MOUNT_VALUES.white || noMountEligible)) {
      onSelectionChange(withMount(selection, value));
    }
  }

  function selectPaper(value: string) {
    // Both papers are sold for every giclée size, so any known paper is valid;
    // the guard keeps a value the selector could not produce out of the state.
    if (isPrintPaperValue(value)) onSelectionChange(withPaper(selection, value));
  }

  function selectDestination(value: string) {
    if (isShipToCountryCode(value)) setDestinationCountry(value);
  }

  async function checkout() {
    track("configurator_submit");
    setBusy(true);
    setError(null);
    try {
      const body = checkoutRequest(
        photoSlug,
        format,
        size,
        frame,
        destinationCountry,
        mount,
        paper,
        locale,
      );

      const res = await postJson("/api/checkout", body);
      const data: unknown = await readJsonResponse(res);
      // The transport status is checked first so the failure's code is the
      // message on every non-ok response, whatever the payload's `url`
      // happens to be.
      if (!res.ok) {
        throw new Error(
          failureCopy(
            data,
            { isCode: isApiErrorCode, copy: copy.apiErrors },
            copy.checkoutFailed,
          ),
        );
      }
      const url = checkoutUrl(data);
      if (!url) {
        throw new Error(copy.checkoutFailed);
      }
      // The redirect target arrives from the API response, so it is treated as
      // untrusted: `checkoutUrl` has already refused anything that is not an
      // absolute https URL on the Stripe checkout origin, on the same
      // synchronous path, before the navigation happens.
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : copy.checkoutFailed);
      setBusy(false);
    }
  }

  const priceLabel = (() => {
    if (isDigital) return eurLabel(DIGITAL_PRICE_EUR, locale);
    if (quoteLoading) return "…";
    if (quote) return eurLabel(quote.merchandiseEur, locale);
    return "—";
  })();

  return (
    <div className="space-y-6">
      <div className="border-y border-gallery-100 py-4 space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="text-xs uppercase tracking-wider text-stone-500">
            {isDigital ? copy.price : copy.print}
          </span>
          <span className="text-2xl font-serif text-stone-900 font-semibold">
            {priceLabel}
          </span>
        </div>
        {!isDigital && (
          <div className="flex justify-between items-baseline text-xs text-stone-500">
            <span>{copy.shippingEstimate}</span>
            <span>
              {quoteLoading
                ? "…"
                : quote
                  ? eurLabel(quote.shippingEur, locale)
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
            {copy.supportedOption}
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
                      : "border border-gallery-200 hover:border-stone-400"
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
                  <div className="text-[10px] text-stone-500">
                    {f.sub}
                    {f.id === "digital" ? ` · ${eurLabel(DIGITAL_PRICE_EUR, locale)}` : ""}
                  </div>
                  {f.id === "digital" && (
                    <div
                      className="text-[10px] text-stone-500 mt-0.5"
                      data-testid="digital-option-resolution"
                    >
                      {resolutionLabel}
                    </div>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        {isDigital ? (
          // The digital copy is the master file itself, so its detail slot
          // states the delivered pixel size instead of offering print sizes
          // (#325). Physical formats are unchanged below.
          <div>
            <span className={fieldLabelClass("compact")}>
              {copy.resolution}
            </span>
            <p
              className="text-xs text-stone-700"
              data-testid="digital-resolution"
            >
              {resolutionLabel}
            </p>
          </div>
        ) : (
          <div>
            <label
              htmlFor="print-size"
              className={fieldLabelClass("compact")}
            >
              {copy.dimensions}
            </label>
            <select
              id="print-size"
              value={size}
              onChange={(e) => selectSize(e.target.value)}
              className={fieldControlClass("compact")}
            >
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {isGiclee && (
          <div>
            <label
              htmlFor="print-paper"
              className={fieldLabelClass("compact")}
            >
              {copy.paper}
            </label>
            <select
              id="print-paper"
              value={paper}
              onChange={(e) => selectPaper(e.target.value)}
              aria-describedby="print-paper-note"
              className={fieldControlClass("compact")}
            >
              {configuratorPapers(locale).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {/* The paper changes the price and the print, not the geometry, so
                the one thing worth saying here is what the paper actually is. */}
            <p id="print-paper-note" className={fieldHintClass()}>
              {paperNote(paper, locale)}
            </p>
          </div>
        )}

        {isFramed && (
          <div>
            <label
              htmlFor="frame-finish"
              className={fieldLabelClass("compact")}
            >
              {copy.frameFinish}
            </label>
            <select
              id="frame-finish"
              value={frame}
              onChange={(e) => selectFrame(e.target.value)}
              // The mount note is visually tied to this control and carries the
              // size a screen reader user would otherwise never hear (#334).
              aria-describedby="frame-mount-note"
              className={fieldControlClass("compact")}
            >
              {configuratorFrames(locale).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {/* #334: the size named above is the window inside the moulding,
                and the photo behind the mount is smaller. Saying so here,
                beside the finish the mount is fixed to, is the last point
                before checkout where it can still change the buyer's mind. */}
            <p id="frame-mount-note" className={fieldHintClass()}>
              {framedMountNote(size, orientation, mount, locale)}
            </p>
          </div>
        )}

        {isFramed && (
          <div>
            <label
              htmlFor="frame-mount"
              className={fieldLabelClass("compact")}
            >
              {copy.mount}
            </label>
            <select
              id="frame-mount"
              value={mount}
              onChange={(e) => selectMount(e.target.value)}
              aria-describedby="frame-mount-help"
              data-mount-select
              className={fieldControlClass("compact")}
            >
              {configuratorMounts(locale).map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  disabled={m.id === FRAMED_MOUNT_VALUES.none && !noMountEligible}
                >
                  {m.label}
                </option>
              ))}
            </select>
            {/* #335: unmounted prints are a different product, so the reason a
                size cannot go without a mount belongs beside the control that
                offers it — never a silent swap back to the mounted version. */}
            <p id="frame-mount-help" className={fieldHintClass()}>
              {mount === FRAMED_MOUNT_VALUES.none
                ? noMountReason ?? copy.mountHelpNone
                : noMountReason ?? copy.mountHelpWhite}
            </p>
          </div>
        )}

        {!isDigital && (
          <div>
            <label
              htmlFor="shipping-country"
              className={fieldLabelClass("compact")}
            >
              {copy.shipTo}
            </label>
            <select
              id="shipping-country"
              value={destinationCountry}
              onChange={(e) => selectDestination(e.target.value)}
              className={fieldControlClass("compact")}
            >
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="pt-4">
          <Button
            type="button"
            shape="form"
            disabled={
              busy ||
              (!isDigital &&
                (!quote ||
                  quoteLoading ||
                  (isFramed &&
                    mount === FRAMED_MOUNT_VALUES.none &&
                    !noMountEligible)))
            }
            onClick={checkout}
          >
            {busy ? copy.openingCheckout : copy.checkout}
          </Button>
          <p className="text-[10px] text-center text-stone-500 mt-2">
            {isDigital ? copy.footnoteDigital : copy.footnotePhysical}
          </p>
          {error && (
            <p className="text-[11px] text-center text-red-700 mt-2" role="alert">
              {error}
            </p>
          )}
          <p className="sr-only">
            {title} — {formatLabel(format, mount, paper, locale)}
          </p>
        </div>
      </div>
    </div>
  );
}

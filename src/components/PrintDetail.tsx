"use client";

/**
 * The photo page's interactive shell (#326): it owns the print selection and
 * renders the live preview beside the configurator, so a change in either is
 * visible in the other with no network request.
 *
 * The selection is pure state (`PrintSelection`), lifted out of
 * `PrintConfigurator`; this component is the only place the two halves meet.
 * The server page passes plain serialisable props — the resolved `GalleryImage`
 * is computed on the server, because `galleryImage()` reads `process.env` and a
 * client component would see it as undefined.
 *
 * The selection's source of truth is the URL (#333), so a variation is
 * shareable. The server snapshot is empty, so SSR and the first paint render
 * the opening selection with no hydration mismatch; the client then reads
 * `window.location` through `useSyncExternalStore`.
 */
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { GalleryImage } from "@/infrastructure/media/gallery-image";
import type { MasterFacts } from "@/domain/catalog/master-facts";
import type { PrintOffer } from "@/domain/catalog/print-offer";
import {
  masterResolutionLabel,
  previewCaption,
  previewLabel,
  previewNote,
} from "@/domain/ordering/print-copy";
import { previewGeometry } from "@/domain/ordering/print-preview";
import type { PrintSelection } from "@/domain/ordering/print-selection";
import {
  selectionFromParams,
  selectionToParams,
} from "@/domain/ordering/print-selection-url";
import { PrintConfigurator } from "./PrintConfigurator";
import { PrintPreview } from "./PrintPreview";

/**
 * The URL is the configurator's source of truth (#333). A real Back or Forward
 * fires `popstate`, which keeps the selection and the address bar in step. A
 * change we make uses `replaceState`, which fires nothing, so it announces
 * itself with its own event — not a synthetic `popstate`, which would also wake
 * Next's router listeners for a navigation that did not happen.
 */
const LOCATION_CHANGED = "print-selection:locationchange";

function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_CHANGED, onChange);
  };
}

const getLocationSearch = () => window.location.search;
const getServerLocationSearch = () => "";

export function PrintDetail({
  photoSlug,
  title,
  offer,
  master,
  image,
  alt,
  filmLookClassName,
  children,
}: {
  photoSlug: string;
  title: string;
  offer: PrintOffer;
  master: MasterFacts;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
  children: ReactNode;
}) {
  const search = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch,
  );
  const selection = useMemo(
    () => selectionFromParams(new URLSearchParams(search), offer),
    [search, offer],
  );

  // Reflect every change back into the URL in place (#333): no navigation, no
  // reload, no request. `replaceState` keeps variations out of history, so Back
  // leaves the page instead of stepping through every control the buyer moved.
  function changeSelection(next: PrintSelection) {
    window.history.replaceState(null, "", `?${selectionToParams(next)}`);
    window.dispatchEvent(new Event(LOCATION_CHANGED));
  }

  const geometry = previewGeometry(selection, master);
  const label = previewLabel(alt, selection, master.orientation);
  const caption = previewCaption(selection, master.orientation);
  const note = previewNote(geometry);
  const size = selection.format === "digital" ? undefined : selection.size;

  return (
    <div className="grid lg:grid-cols-12 gap-12 items-start">
      <div className="lg:col-span-7 space-y-3 lg:sticky lg:top-28 self-start">
        <PrintPreview
          geometry={geometry}
          image={image}
          alt={alt}
          label={label}
          filmLookClassName={filmLookClassName}
          master={master}
          size={size}
        />
        {/*
         * `gap-*` and not `justify-between` alone: justify-between distributes
         * only the *free* space, so a caption long enough to use it all (framed
         * names the size, the moulding and the mount) left the print size butted
         * against the pixel size with nothing between them. The gap makes the
         * separation a floor instead of a dividend, and `flex-wrap` turns the
         * overflow it would otherwise cause into a second row.
         */}
        <div
          data-testid="preview-meta"
          className="flex flex-wrap justify-between gap-x-6 gap-y-2 text-[10px] text-stone-500 uppercase tracking-widest px-1"
        >
          <span data-testid="preview-meta-caption">{caption}</span>
          <span data-testid="preview-meta-resolution">
            {masterResolutionLabel(master)}
          </span>
          <span>Global Delivery via Prodigi</span>
        </div>
        {note && (
          <p className="text-[11px] text-stone-500 normal-case tracking-normal px-1">
            {note}
          </p>
        )}
      </div>

      <div className="lg:col-span-5 bg-white p-8 rounded-sm border border-gallery-200/80 shadow-sm space-y-6">
        {children}
        <PrintConfigurator
          photoSlug={photoSlug}
          title={title}
          offer={offer}
          master={master}
          selection={selection}
          onSelectionChange={changeSelection}
        />
      </div>
    </div>
  );
}

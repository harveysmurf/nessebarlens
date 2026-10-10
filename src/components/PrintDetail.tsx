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
 */
import { useState, type ReactNode } from "react";
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
import {
  openingSelection,
  type PrintSelection,
} from "@/domain/ordering/print-selection";
import { PrintConfigurator } from "./PrintConfigurator";
import { PrintPreview } from "./PrintPreview";

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
  const [selection, setSelection] = useState<PrintSelection>(() =>
    openingSelection(offer),
  );

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
        <div className="flex justify-between text-[10px] text-stone-400 uppercase tracking-widest px-1">
          <span>{caption}</span>
          <span>{masterResolutionLabel(master)}</span>
          <span>Global Delivery via Prodigi</span>
        </div>
        {note && (
          <p className="text-[11px] text-stone-500 normal-case tracking-normal px-1">
            {note}
          </p>
        )}
      </div>

      <div className="lg:col-span-5 bg-white p-8 rounded-sm border border-stone-200/80 shadow-sm space-y-6">
        {children}
        <PrintConfigurator
          photoSlug={photoSlug}
          title={title}
          offer={offer}
          master={master}
          selection={selection}
          onSelectionChange={setSelection}
        />
      </div>
    </div>
  );
}

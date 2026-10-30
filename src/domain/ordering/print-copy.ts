/**
 * The copy behind the print configurator's selectors.
 *
 * FORMATS and FRAMES are keyed off the sku-map lists, never hand-typed here: a
 * hand-typed duplicate of those lists produces a configurator that silently
 * cannot offer a newly pinned Prodigi SKU, with no type error and no test. The
 * size list is the photo's own print offer (#302), in table order — see
 * `sizeOptions`/`offeredFormats` below. The home and story pages already carry
 * partial copies of the same idea.
 *
 * These are Records keyed by the id, not arrays of id/label pairs, which is
 * the whole point: adding a format, size or frame finish to the catalog makes
 * this file a compile error until someone writes the words for it. An array
 * cannot fail to compile in that situation; a Record cannot skip it.
 *
 * The ids are derived from the lists at the bottom, so the selector order
 * follows the catalog rather than a second hand-maintained sequence.
 *
 * Note the titles here are configurator copy and deliberately differ from
 * `pricing.ts` FORMAT_LABELS ("Giclée Fine Art" vs "Giclée Fine Art Print"):
 * one is a button, the other an order line. They are separate vocabularies,
 * not copies of each other, so neither is derived from the other.
 *
 * **The copy is per locale.** Every map here is keyed by locale first and by
 * the product id second, so a locale that arrives without words for a new
 * product is a compile error rather than an empty option in the selector. The
 * product *ids* are not translated — `giclee`, `framed`, `black`, `ema` — and
 * neither are the request values built from them: what the buyer picks is the
 * same in every language.
 *
 * A product's own name is not translated either. "Matte Art" and "Hahnemühle
 * Photo Rag" are the papers Prodigi prints on, and a Bulgarian selector that
 * spelled them differently would be offering a paper that does not exist. What
 * is translated is the description around them.
 */

import type { MasterFacts, Orientation } from "../catalog/master-facts";
import type { PrintOffer } from "../catalog/print-offer";
import {
  sizeLabel,
  type FrameFinish,
  type PrintFormat,
  type PrintSize,
} from "../pricing/pricing";
import {
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_PAPER,
  FRAMED_MOUNTS,
  PRINT_PAPERS,
  PRINT_PRODUCTS,
  printAreaIn,
  type FramedMount,
  type PrintPaper,
  type PrintProductEntry,
} from "../pricing/print-products";
import { FRAME_FINISHES, SELLABLE_FORMATS } from "../pricing/sku-map";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locale";
import {
  CANVAS_BAR_DEPTH_MM,
  CLASSIC_FRAME_MOULDING_MM,
  PREVIEW_KINDS,
  type PreviewGeometry,
} from "./print-preview";
import type { PrintSelection } from "./print-selection";

export type FormatCopy = { title: string; sub: string };
export type FormatOption = { id: PrintFormat } & FormatCopy;

const FORMAT_COPY: Record<Locale, Record<PrintFormat, FormatCopy>> = {
  en: {
    // #337: the subtitle is now true for both papers, so it names neither. The
    // paper is a per-size choice below, and the concrete paper is on the selected
    // paper's own helper line and on the order line.
    giclee: { title: "Giclée Fine Art", sub: "Matte Art or Hahnemühle" },
    // #334: the mount is half of what ships, so the button says so. "Wood Frame",
    // not "Solid Wood Frame" — the brown finish is an oak-effect laminate, and
    // the mount is the fact the buyer is actually missing.
    framed: { title: "Framed Print", sub: "Wood Frame · White Mount" },
    canvas: { title: "Stretched Canvas", sub: "Cotton Canvas" },
    digital: { title: "Digital Copy", sub: "Full Resolution JPG" },
  },
  bg: {
    giclee: { title: "Художествен отпечатък (giclée)", sub: "Matte Art или Hahnemühle" },
    framed: { title: "Художествен отпечатък с рамка", sub: "Дървена рамка · Бяло паспарту" },
    canvas: { title: "Печат върху платно", sub: "Памучно платно" },
    digital: { title: "Дигитален файл", sub: "JPG файл с пълна резолюция" },
  },
};

const FRAME_COPY: Record<Locale, Record<FrameFinish, string>> = {
  en: {
    black: "Matte Black",
    white: "Satin White",
    brown: "Brown Wood",
  },
  bg: {
    black: "Матово черно",
    white: "Сатенено бяло",
    brown: "Кафяво дърво",
  },
};

/** Frame finishes as phrases before "frame" in a Bulgarian sentence. */
const FRAME_PHRASE: Record<Locale, Record<FrameFinish, string>> = {
  en: FRAME_COPY.en,
  bg: {
    black: "черна матова",
    white: "бяла сатенена",
    brown: "кафява",
  },
};

/**
 * The mount control's copy (#335), keyed by mount so a new mount is a compile
 * error until it has words — the same rule the format and frame Records follow.
 */
const MOUNT_COPY: Record<Locale, Record<FramedMount, string>> = {
  en: {
    white: "White Mount",
    none: "No Mount",
  },
  bg: {
    white: "Бяло паспарту",
    none: "Без паспарту",
  },
};

/** The lower-case phrase for the mount, for the preview label. */
const MOUNT_PHRASE: Record<Locale, Record<FramedMount, string>> = {
  en: {
    white: "white mount",
    none: "no mount",
  },
  bg: {
    white: "бяло паспарту",
    none: "без паспарту",
  },
};

/**
 * The giclée Paper control's copy (#337), keyed by paper so a new paper is a
 * compile error until it has words — the same rule the format, frame and mount
 * Records follow. The weights are the verified Prodigi facts (EMA 200gsm,
 * Photo Rag 308gsm); the note under the select is one short true line each.
 */
const PAPER_COPY: Record<Locale, Record<PrintPaper, string>> = {
  en: {
    ema: "Matte Art · 200gsm",
    hpr: "Hahnemühle Photo Rag · 308gsm",
  },
  bg: {
    // The paper's own name is a product name and stays as it is written.
    ema: "Matte Art · 200gsm",
    hpr: "Hahnemühle Photo Rag · 308gsm",
  },
};

const PAPER_NOTE: Record<Locale, Record<PrintPaper, string>> = {
  en: {
    ema: "Smooth heavyweight matte, natural white.",
    // Deliberately no acid-free claim: Prodigi does not state it for Photo Rag.
    hpr: "100% cotton rag, soft matte with a fine felt texture.",
  },
  bg: {
    ema: "Гладка плътна матова хартия с естествено бял тон.",
    // Deliberately no acid-free claim: Prodigi does not state it for Photo Rag.
    hpr: "100% памучна хартия с мека матова повърхност и фина текстура.",
  },
};

const CM_PER_INCH = 2.54;

/** A framed product's mount window in whole cm, short edge first. */
function imageSizeCm(product: PrintProductEntry): {
  short: number;
  long: number;
} {
  const area = printAreaIn(product);
  return {
    short: Math.round(area.short * CM_PER_INCH),
    long: Math.round(area.long * CM_PER_INCH),
  };
}

/**
 * Every framed size's visible area in whole cm, per mount (#334, #335):
 * the mount window for White Mount, the full glaze for No Mount. Derived from
 * the pinned print areas rather than typed in, so the number on the option is
 * the number the preview draws. The issue's reference table is checked against
 * this in tests, which is what catches a drifted Prodigi catalogue.
 *
 * Whole cm because that is the unit the size on the button is in: a 12 × 16 in
 * window is 20.32 × 30.48 cm, and the honest thing to tell a buyer next to
 * "30 × 40 cm" is "20 × 30 cm".
 */
const MOUNT_IMAGE_SIZE_CM: Record<
  FramedMount,
  Record<PrintSize, { short: number; long: number }>
> = Object.fromEntries(
  FRAMED_MOUNTS.map((mount) => [
    mount,
    Object.fromEntries(
      PRINT_PRODUCTS.filter(
        (product) => product.format === "framed" && product.mount === mount,
      ).map((product) => [product.size, imageSizeCm(product)]),
    ),
  ]),
) as Record<FramedMount, Record<PrintSize, { short: number; long: number }>>;

/**
 * The photo's visible size for a framed product (#334), e.g. `20 × 30 cm` for a
 * framed window, or the full glaze size for an unmounted print (#335).
 * Orientation is the photo's, exactly as `sizeLabel`: a landscape photo hangs
 * long edge first, and the window turns with it.
 */
export function imageSizeLabel(
  size: PrintSize,
  orientation: Orientation,
  mount: FramedMount = DEFAULT_FRAMED_MOUNT,
): string {
  const area = MOUNT_IMAGE_SIZE_CM[mount][size];
  return orientation === "landscape"
    ? `${area.long} × ${area.short} cm`
    : `${area.short} × ${area.long} cm`;
}

/**
 * The helper line under the Frame Finish / Mount selects (#334, #335).
 *
 * A function, not a constant, because the one fact that matters here — how big
 * the photo actually is — depends on the size and mount the buyer just chose.
 * This is also why the visible size is not on the size option: the select has
 * to stay short enough to fit at 320px (#331), and this line wraps and has room.
 *
 * Deliberately says acrylic and never glass, and never names a paper: a CFPM
 * is EMA 200gsm, and the giclée button carries the paper claim for its own
 * format (#336), so this note must not repeat or invent one.
 */
export function framedMountNote(
  size: PrintSize,
  orientation: Orientation,
  mount: FramedMount = DEFAULT_FRAMED_MOUNT,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const moulding = Math.round(CLASSIC_FRAME_MOULDING_MM / 10);
  if (locale === "bg") {
    if (mount === "none") {
      return (
        `Акрилно стъкло, без паспарту, готово за окачване. ` +
        `Снимката запълва рамката от край до край с размери ${imageSizeLabel(size, orientation, mount)}; ` +
        `рамката добавя около ${moulding} см от всяка страна.`
      );
    }
    return (
      `Бяло паспарту, акрилно стъкло, готово за окачване. ` +
      `Снимката се вижда с размери ${imageSizeLabel(size, orientation, mount)} зад паспарту; ` +
      `рамката добавя около ${moulding} см ` +
      `от всяка страна.`
    );
  }
  if (mount === "none") {
    return (
      `Acrylic glazing, no mount, ready to hang. ` +
      `Your photo fills the frame edge to edge at ${imageSizeLabel(size, orientation, mount)}; ` +
      `the frame adds about ${moulding} cm on each side.`
    );
  }
  return (
    `Snow-white acid-free mount, acrylic glazing, ready to hang. ` +
    `Your photo shows at ${imageSizeLabel(size, orientation, mount)} behind the mount; ` +
    `the frame adds about ${moulding} cm ` +
    `on each side.`
  );
}

/** One entry per sellable format, in catalog order. */
export function configuratorFormats(
  locale: Locale = DEFAULT_LOCALE,
): FormatOption[] {
  return SELLABLE_FORMATS.map((id) => ({ id, ...FORMAT_COPY[locale][id] }));
}

/**
 * The formats the configurator shows for a photo's offer (#302): digital, which
 * is always offered, and each physical format that has at least one offered
 * size. A format with nothing offered is hidden, not shown greyed out, so the
 * buyer never picks a format that cannot be bought.
 */
export function offeredFormats(
  offer: PrintOffer,
  locale: Locale = DEFAULT_LOCALE,
): FormatOption[] {
  return configuratorFormats(locale).filter((option) =>
    option.id === "digital" ? true : offer[option.id].length > 0,
  );
}

/**
 * The offered sizes for a physical format, in table order, labelled for the
 * photo's orientation (#302). Digital carries no size, so it has none.
 */
export function sizeOptions(
  offer: PrintOffer,
  format: PrintFormat,
  orientation: Orientation,
  locale: Locale = DEFAULT_LOCALE,
): Array<{ id: PrintSize; label: string }> {
  if (format === "digital") return [];
  return offer[format].map((size) => ({
    id: size,
    label: sizeLabel(size, orientation, locale),
  }));
}

/** The first offered physical size of a format, or `undefined`. */
export function firstOfferedSize(
  offer: PrintOffer,
  format: PrintFormat,
): PrintSize | undefined {
  if (format === "digital") return undefined;
  return offer[format][0];
}

/**
 * The digital copy's delivered pixel size, e.g. `7952 × 5304 px` (#325).
 *
 * The download streams the master file unchanged, so the master's oriented
 * dimensions are exactly the pixels the buyer receives. Formatting lives here
 * rather than in the component so the page, the configurator and any test read
 * the same string from the same `MasterFacts` (#295), never a hand-typed size.
 */
export function masterResolutionLabel(master: MasterFacts): string {
  return `${master.width} × ${master.height} px`;
}

/**
 * The preview's accessible label (#326), keyed by format so a new format is a
 * compile error here. It names the format, the labelled size and, for a framed
 * print, the finish and the white mount.
 */
const PREVIEW_LABEL: Record<
  Locale,
  Record<
    PrintFormat,
    (alt: string, selection: PrintSelection, orientation: Orientation) => string
  >
> = {
  en: {
    giclee: (alt, selection, orientation) =>
      `${alt} — giclée fine art print, ${sizeLabel(selection.size, orientation, "en")}`,
    framed: (alt, selection, orientation) =>
      `${alt} — framed print, ${sizeLabel(selection.size, orientation, "en")}, ${FRAME_COPY.en[selection.frame]} frame with ${MOUNT_PHRASE.en[selection.mount]}`,
    canvas: (alt, selection, orientation) =>
      `${alt} — stretched canvas, ${sizeLabel(selection.size, orientation, "en")}, image wrapped around the ${CANVAS_BAR_DEPTH_MM} mm edges`,
    digital: (alt) => alt,
  },
  bg: {
    giclee: (alt, selection, orientation) =>
      `${alt} — художествен фотографски отпечатък giclée, ${sizeLabel(selection.size, orientation, "bg")}`,
    framed: (alt, selection, orientation) =>
      `${alt} — художествен отпечатък в ${FRAME_PHRASE.bg[selection.frame]} рамка, ${sizeLabel(selection.size, orientation, "bg")}, ${MOUNT_PHRASE.bg[selection.mount]}`,
    canvas: (alt, selection, orientation) =>
      `${alt} — печат върху платно, ${sizeLabel(selection.size, orientation, "bg")}, изображението се прегъва около ръбовете с дебелина ${CANVAS_BAR_DEPTH_MM} мм`,
    digital: (alt) => alt,
  },
};

export function previewLabel(
  alt: string,
  selection: PrintSelection,
  orientation: Orientation,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return PREVIEW_LABEL[locale][selection.format](alt, selection, orientation);
}

/**
 * The caption under the stage (#326), keyed by format. It names the product,
 * the labelled size and, for framed, the finish. Digital states the full frame
 * because the whole uncropped photo is shown.
 */
const PREVIEW_CAPTION: Record<
  Locale,
  Record<PrintFormat, (selection: PrintSelection, orientation: Orientation) => string>
> = {
  en: {
    giclee: (selection, orientation) =>
      `Giclée Fine Art · ${sizeLabel(selection.size, orientation, "en")}`,
    framed: (selection, orientation) =>
      `Framed Print · ${sizeLabel(selection.size, orientation, "en")} · ${FRAME_COPY.en[selection.frame]} · ${MOUNT_COPY.en[selection.mount]}`,
    canvas: (selection, orientation) =>
      `Stretched Canvas · ${sizeLabel(selection.size, orientation, "en")}`,
    digital: () => "Digital Copy · full frame",
  },
  bg: {
    giclee: (selection, orientation) =>
      `Художествен отпечатък giclée · ${sizeLabel(selection.size, orientation, "bg")}`,
    framed: (selection, orientation) =>
      `Художествен отпечатък · ${sizeLabel(selection.size, orientation, "bg")} · ${FRAME_PHRASE.bg[selection.frame]} рамка · ${MOUNT_COPY.bg[selection.mount]}`,
    canvas: (selection, orientation) =>
      `Печат върху платно · ${sizeLabel(selection.size, orientation, "bg")}`,
    digital: () => "Цифров файл · пълният кадър",
  },
};

export function previewCaption(
  selection: PrintSelection,
  orientation: Orientation,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return PREVIEW_CAPTION[locale][selection.format](selection, orientation);
}

/**
 * The note under the caption (#326), or null. Canvas explains the wrap; a
 * paper or framed print whose crop discards at least 1% of the photo says so,
 * because the buyer is seeing a real trim, not a decorative crop.
 */
export function previewNote(
  geometry: PreviewGeometry,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  if (geometry.kind === PREVIEW_KINDS.canvas) {
    const cm = Math.round(geometry.wrapMm.x / 10);
    return locale === "bg"
      ? `Външните ${cm} см от снимката се увиват около страните на канавата.`
      : `The outer ${cm} cm of the photo wraps around the sides of the canvas.`;
  }
  if (
    (geometry.kind === PREVIEW_KINDS.paper ||
      geometry.kind === PREVIEW_KINDS.framed) &&
    geometry.cropFraction >= 0.01
  ) {
    return locale === "bg"
      ? "Отпечатките запълват хартията от край до край, затова снимката се изрязва леко при този размер — визуализацията показва точно какво се печата."
      : "Prints fill the paper edge to edge, so the photo is trimmed slightly at this size — the preview shows exactly what is printed.";
  }
  return null;
}

/**
 * Fallbacks for the configurator's opening selection.
 *
 * The opening format and size are the photo's first offered ones (#302); these
 * are only reached if an offer has no physical format at all, where the size is
 * unused anyway. They were three literals in the component's useState calls —
 * the last hand-typed catalog values in the file — and are exported so a test
 * can assert they are members of the catalog lists.
 */
export const DEFAULT_PRINT_FORMAT: PrintFormat = "giclee";
export const DEFAULT_PRINT_SIZE: PrintSize = "50x70";
export const DEFAULT_FRAME_FINISH: FrameFinish = "black";
// The default mount and paper are owned by print-products (each is part of the
// product key); re-exported here so the configurator's defaults all come from
// one module.
export { DEFAULT_FRAMED_MOUNT, DEFAULT_PRINT_PAPER };

/** One entry per frame finish, in catalog order. */
export function configuratorFrames(locale: Locale = DEFAULT_LOCALE) {
  return FRAME_FINISHES.map((id) => ({
    id,
    label: FRAME_COPY[locale][id],
  }));
}

/** One entry per framed mount, in catalog order (#335). */
export function configuratorMounts(locale: Locale = DEFAULT_LOCALE) {
  return FRAMED_MOUNTS.map((id) => ({
    id,
    label: MOUNT_COPY[locale][id],
  }));
}

/** One entry per giclée paper, in catalog order (#337). */
export function configuratorPapers(locale: Locale = DEFAULT_LOCALE) {
  return PRINT_PAPERS.map((id) => ({
    id,
    label: PAPER_COPY[locale][id],
  }));
}

/**
 * The helper line under the Paper select (#337). A paper is one product we
 * actually stock, so the line states its real material — and no acid-free
 * claim, which Prodigi does not make for Photo Rag.
 */
export function paperNote(
  paper: PrintPaper,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return PAPER_NOTE[locale][paper];
}

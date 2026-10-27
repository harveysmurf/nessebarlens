import type { Orientation } from "../catalog/master-facts";
import {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  type Locale,
} from "../i18n/locale";
import { Eur, eurToCents } from "./money";
import {
  DEFAULT_FRAMED_MOUNT,
  DEFAULT_PRINT_PAPER,
  PRINT_PRODUCTS,
  type FramedMount,
  type PrintPaper,
  type PrintSize,
} from "./print-products";

/**
 * The EUR grammar and the cents conversion are money.ts's; these two names
 * stay on `pricing` because that is where every caller already imports them
 * from. The re-export is the one named exception to "a module only exports
 * what it defines" in tests/single-source-grammar.test.mts, so a second path
 * to a declaration anywhere else still fails there.
 */
export { eurToCents, parseEurAmount } from "./money";

/**
 * The formats the site sells, in catalog order.
 *
 * One list, so the union below and the allow-lists derived from it cannot
 * drift. The union and the physical list were two spellings of one vocabulary:
 * a format added to the union was a format the site could price and could not
 * sell, because the parsers allow-listed the list rather than the union, and
 * nothing failed until a buyer picked it.
 */
export const PRINT_FORMATS = ["giclee", "framed", "canvas", "digital"] as const;

export type PrintFormat = (typeof PRINT_FORMATS)[number];
// PrintSize is the print table's size column; re-exported here because that is
// where every caller already imports it from (print-products.ts owns it).
export type { PrintSize };
export type FrameFinish = "black" | "white" | "brown";

/** Merchandise-only EUR. Shipping is separate (Stripe shipping_options). */
export const DIGITAL_PRICE_EUR = 30;

/** Customer merchandise = Prodigi unitCost × this margin. */
export const PRODIGI_MARGIN = 1.2;

/**
 * An amount as the site shows it, in the locale's own conventions.
 *
 * money.ts owns the decimal rule — `Eur` is the one place an amount becomes
 * cents — and `Intl.NumberFormat` owns the display: the symbol's position, the
 * decimal separator and the thousands separator are the locale's, not the
 * site's. English writes `€30.00` and Bulgarian writes `30,00 €`, and the
 * amount is the same number either way.
 *
 * The format is the one every displayed amount goes through, so a page cannot
 * show a euro sign in one place and a decimal point in another. The currency
 * is EUR because that is what the site sells; the locale comes from the
 * registry, so there is no second list of tags here.
 *
 * The amount goes through `Eur`, so a non-finite or over-cap value throws here
 * instead of rendering "€NaN" to a buyer. `isQuotePayload` is what keeps that
 * unreachable for the quote amounts; the digital price is a literal above.
 */
export function eurLabel(
  amountEur: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const cents = Eur.fromCents(eurToCents(amountEur)).cents();
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

/**
 * The margin is applied to whole cents, not to a float: the unit cost is a
 * parsed EUR amount, so it has cents already, and the only rounding left is
 * the one that folds the scaled cents back into an integer. The result goes
 * back to the float EUR the quote and Stripe metadata speak.
 */
export function merchandiseFromUnitCost(unitCostEur: number): number {
  const unitCost = Eur.fromCents(eurToCents(unitCostEur));
  return unitCost.multiplyBy(PRODIGI_MARGIN).cents() / 100;
}

// Typed as Record<union, string> rather than switch: adding a member to
// PrintFormat/PrintSize then fails to compile here instead of silently
// returning undefined at runtime.
//
// Framed names the mount (#334, #335): the receipt has to match the print that
// arrives, and mounted and unmounted are different products.
//
// The labels are per locale, because the order line is the customer's receipt
// and a receipt in the wrong language is a receipt they cannot read. What is
// *not* translated is the product's own name: "Matte Art" and "Hahnemühle
// Photo Rag" are the papers Prodigi prints on, and a Bulgarian receipt that
// spelled them differently would be naming a paper that does not exist.
const FORMAT_LABELS: Record<Locale, Record<PrintFormat, string>> = {
  en: {
    giclee: "Giclée Fine Art Print",
    framed: "Framed Fine Art",
    canvas: "Stretched Canvas",
    digital: "High-Res Digital Download",
  },
  bg: {
    giclee: "Финиарт giclée",
    framed: "Финиарт в рамка",
    canvas: "Опъната канава",
    digital: "Цифров файл с висока резолюция",
  },
};

/** The mount's parenthetical on a framed order line, keyed so a new mount is a
 *  compile error until it has words. */
const MOUNT_LABELS: Record<Locale, Record<FramedMount, string>> = {
  en: {
    white: "White Mount",
    none: "No Mount",
  },
  bg: {
    white: "Бяла паспарту",
    none: "Без паспарту",
  },
};

/** The paper's parenthetical on a giclée order line (#337), keyed so a new
 *  paper is a compile error until it has words. The paper's own name is a
 *  product name and is the same in every language. */
const PAPER_LABELS: Record<Locale, Record<PrintPaper, string>> = {
  en: {
    ema: "Matte Art 200gsm",
    hpr: "Hahnemühle Photo Rag 308gsm",
  },
  bg: {
    ema: "Matte Art 200gsm",
    hpr: "Hahnemühle Photo Rag 308gsm",
  },
};

/** "30x40" → "30 × 40"; used for both the cm and the inch half. */
function sizeWords(size: string): string {
  const [a, b] = size.split("x");
  return `${a} × ${b}`;
}

/** "30 × 40" → "40 × 30". */
function reversedWords(words: string): string {
  const [a, b] = words.split(" × ");
  return `${b} × ${a}`;
}

/** The cm and inch words per size, short edge first, derived from the table. */
const SIZE_WORDS: Record<PrintSize, { cm: string; inches: string }> =
  Object.fromEntries(
    PRINT_PRODUCTS.map((product) => [
      product.size,
      { cm: sizeWords(product.size), inches: sizeWords(product.sizeIn) },
    ]),
  ) as Record<PrintSize, { cm: string; inches: string }>;

export function formatLabel(
  format: PrintFormat,
  mount: FramedMount = DEFAULT_FRAMED_MOUNT,
  paper: PrintPaper = DEFAULT_PRINT_PAPER,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (format === "framed") {
    return `${FORMAT_LABELS[locale].framed} (${MOUNT_LABELS[locale][mount]})`;
  }
  if (format === "giclee") {
    return `${FORMAT_LABELS[locale].giclee} (${PAPER_LABELS[locale][paper]})`;
  }
  return FORMAT_LABELS[locale][format];
}

/**
 * The unit each locale writes a size in.
 *
 * Centimetres are centimetres in both languages, but the abbreviation is the
 * locale's: English writes "cm", Bulgarian writes "см". The inch is marked with
 * the locale's own sign — a double prime rather than a straight quote, which
 * is what a Bulgarian typographic convention uses for inches.
 */
const SIZE_UNITS: Record<Locale, { cm: string; inches: string }> = {
  en: { cm: "cm", inches: '"' },
  bg: { cm: "см", inches: "″" },
};

/**
 * Label per size, derived from the table so a size cannot be offered without
 * words. The tier words ("Standard"/"Medium"/"Gallery") are gone: the area
 * order already tells the buyer which is larger, and a tier name that is not
 * in the table is a second vocabulary to maintain.
 *
 * A landscape photo reads long edge first (#302): the frame is the product's
 * (portrait) orientation, but the *photo* hangs landscape, so its width is the
 * long edge and naming it first matches what the buyer sees. The cm size and
 * the Prodigi SKU stay short edge first — this is presentation only, and the
 * value the checkout carries is unchanged.
 */
export function sizeLabel(
  size: PrintSize,
  orientation?: Orientation,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const { cm, inches } = SIZE_WORDS[size];
  const unit = SIZE_UNITS[locale];
  if (orientation === "landscape") {
    return `${reversedWords(cm)} ${unit.cm} (${reversedWords(inches)}${unit.inches})`;
  }
  return `${cm} ${unit.cm} (${inches}${unit.inches})`;
}

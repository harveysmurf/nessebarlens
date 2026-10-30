/**
 * The copy the checkout shows, per locale.
 *
 * Two things live here, and they are here for the same reason: they are words
 * that belong to the checkout, they have to be written once per locale, and
 * the code that renders them is not a component — it is the Stripe adapter and
 * a server page — so neither of them can take a prop.
 *
 * **The hosted checkout page.** The page itself belongs to the payment
 * provider and is not ours to translate — the provider decides what language
 * its shell speaks, and the research epic owns that question. What *is* ours is
 * the line item we hand the provider: its name, its description, and the
 * shipping option's name. Those are written here, in the buyer's language.
 *
 * Domain-safe on purpose — no React, no dictionaries, no environment. The same
 * rule `src/domain/i18n/locale.ts` states: the copy for a locale lives beside
 * the values, keyed by locale, and the caller passes the locale it already has.
 *
 * The product *ids* are not translated. `giclee`, `framed`, `black`, `ema` are
 * what the buyer picks and what the order records, and a receipt naming a
 * frame finish that does not exist is worse than an English receipt.
 */

import { DEFAULT_LOCALE, type Locale } from "../i18n/locale";
import { pluralUnit, type LocaleUnits } from "../i18n/plurals";
import type { FrameFinish } from "../pricing/pricing";

/**
 * The frame as a noun phrase, so the sentence around it can be translated.
 *
 * Not derived from the configurator's frame label on purpose. That label is an
 * adjective phrase — "Matte Black", "Матов черен" — and Bulgarian adjectives
 * agree with the noun they describe: the frame is "рамка", feminine, so the
 * phrase is "матова черна рамка", not "матов черен рамка". Borrowing the
 * adjective verbatim would produce a line item in ungrammatical Bulgarian, so
 * the noun phrase is written here in its own right.
 *
 * The words are the ones the line item already used — "black frame" — so the
 * only thing that changes with the locale is the language they are in.
 */
const FRAME_PHRASE: Record<Locale, Record<FrameFinish, string>> = {
  en: {
    black: "black frame",
    white: "white frame",
    brown: "brown frame",
  },
  bg: {
    black: "черна рамка",
    white: "бяла рамка",
    brown: "кафява рамка",
  },
};

/** The digital line item's description. */
const DIGITAL_DESCRIPTION: Record<Locale, string> = {
  en: "Digital high-resolution license",
  bg: "Цифров лиценз с висока резолюция",
};

/** The shipping option's display name on the hosted checkout page. */
const SHIPPING_NAME: Record<Locale, string> = {
  en: "Shipping",
  bg: "Доставка",
};

/**
 * The description of a physical line item: the size, and the frame if there
 * is one.
 *
 * The size is the size — the value the buyer picked and the order records —
 * and it is not restated in words. Only the frame is a phrase, because only the
 * frame is a phrase in English too.
 */
export function physicalDescription(
  size: string,
  frame: FrameFinish | null,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return frame ? `${size} · ${FRAME_PHRASE[locale][frame]}` : size;
}

/** The description of a digital line item. */
export function digitalDescription(
  locale: Locale = DEFAULT_LOCALE,
): string {
  return DIGITAL_DESCRIPTION[locale];
}

/** The shipping option's display name on the hosted checkout page. */
export function shippingDisplayName(
  locale: Locale = DEFAULT_LOCALE,
): string {
  return SHIPPING_NAME[locale];
}

/**
 * The unit words for the counts the checkout pages state, per locale.
 *
 * The words are the dictionary's; this is the shape they have to have, so the
 * phrases below cannot read a unit that is not there.
 */
export type CountUnits = {
  day: LocaleUnits;
  hour: LocaleUnits;
  minute: LocaleUnits;
  /** The unit of "how many times a link may be used". */
  time: LocaleUnits;
};

/**
 * "30 days", "12 часа" — never a raw seconds count at the customer.
 *
 * The unit is chosen by how the number divides, and the word for it is chosen
 * by the language's own plural rules, because "1 ден" and "2 дни" are two
 * different words and not two spellings of one.
 */
export function ttlPhrase(
  seconds: number,
  units: CountUnits,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (seconds % 86_400 === 0) {
    return pluralUnit(seconds / 86_400, units.day, locale);
  }
  if (seconds % 3_600 === 0) {
    return pluralUnit(seconds / 3_600, units.hour, locale);
  }
  return pluralUnit(Math.round(seconds / 60), units.minute, locale);
}

/**
 * The holes in the ready-download sentence, filled from the deployment's
 * configuration.
 *
 * A sentence with holes rather than a sentence with a number in it, because the
 * number is a fact about the deployment: the same words say "three times" on a
 * deployment configured for three downloads and "five times" on one configured
 * for five, and neither is written down in the copy.
 */
export function fillDownloadSentence(
  sentence: string,
  values: { uses: string; ttl: string },
): string {
  return sentence.replace("{uses}", values.uses).replace("{ttl}", values.ttl);
}

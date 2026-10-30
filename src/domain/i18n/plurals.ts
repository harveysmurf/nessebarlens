/**
 * A count and its unit, in the reader's language.
 *
 * "1 day" is not "1 ден" and "2 days" is not "2 дни" by appending an `s`: the
 * unit is a word that changes with the number, and the rules for how it changes
 * are the language's, not the programmer's. English has one form for one and
 * another for everything else; Bulgarian has one for one and another for
 * everything else too — but the words are different ones, "ден" and "дни" — so a
 * rule that only knows how to add an `s` produces a Bulgarian sentence nobody
 * wrote.
 *
 * The categories come from `Intl.PluralRules`, so the language's own rules
 * decide, and the words come from the dictionary, so a locale that needs a
 * category the others do not use does not need a new mechanism.
 *
 * Domain-safe: no React, no dictionaries, no environment. The copy that names
 * the units is passed in.
 */

import { LOCALE_TAGS, type Locale } from "./locale";

/**
 * The plural categories the site's languages use.
 *
 * `Intl` knows six ("zero", "one", "two", "few", "many", "other"); these are
 * the four that carry a unit word. A language that used one of the other two
 * would fall back to "other", which is the plural form in every language here.
 *
 * English and Bulgarian between them use two of them: "one" for the single
 * case and "other" for everything else. "few" and "many" are in the set because
 * `Intl` names them and a third language may need them, not because either
 * language here selects them.
 */
export type PluralCategory = "one" | "few" | "many" | "other";

/**
 * Every category `Intl` can name, mapped onto the four with a unit word.
 *
 * A Record keyed by `Intl`'s own union, not a filter with a fallback: the table
 * is total, so a category this module does not carry a word for is a reading of
 * the table rather than a branch no test can reach.
 */
const CATEGORY: Record<Intl.LDMLPluralRule, PluralCategory> = {
  zero: "other",
  one: "one",
  two: "other",
  few: "few",
  many: "many",
  other: "other",
};

/**
 * The unit words for one kind of thing, in one language.
 *
 * A Record and not an array of pairs, so a locale that arrives without a word
 * for a category is a type error rather than an empty string in a sentence.
 *
 * One language, not every language: the words belong to the dictionary of the
 * locale they are written for, and a dictionary that carried the other
 * locale's words would be carrying a second dictionary inside it.
 */
export type LocaleUnits = Record<PluralCategory, string>;

/**
 * The category a count falls into, in a locale.
 *
 * The rules come from the locale's own tag, so `en-GB` and `bg-BG` decide, not
 * a table written here. A count that lands in a category this module does not
 * name reads as "other", which is the plural form in every language here.
 */
export function pluralCategory(count: number, locale: Locale): PluralCategory {
  const selected = new Intl.PluralRules(LOCALE_TAGS[locale]).select(count);
  return CATEGORY[selected];
}

/**
 * The count and its unit, in the reader's language: "1 day", "2 дни".
 *
 * The number is written as it is. Every count this is used for is a small
 * integer, and every locale writes small integers the same way, so a number
 * formatter would add a dependency on ICU data for no difference a reader could
 * see.
 */
export function pluralUnit(
  count: number,
  units: LocaleUnits,
  locale: Locale,
): string {
  return `${count} ${units[pluralCategory(count, locale)]}`;
}

/**
 * The locale registry, the path helper and the dictionaries.
 *
 * This is the foundation slice of the localisation epic: the locale module, the
 * one helper that builds a localized URL, and the static dictionaries. Three
 * properties are held here, and they are the three that make the rest of the
 * epic possible.
 *
 *   1. **The registry is the only list.** `LOCALES` is every locale the site
 *      knows; `PUBLIC_LOCALES` is every locale it *serves*. A locale that is
 *      known but not served has no route, so `/bg` is a 404 rather than an
 *      English page wearing a Bulgarian URL — the integration guard the epic
 *      asks for. Nothing else in `src/` may hold a second list of locales.
 *
 *   2. **The path helper is the only way to build a URL.** It prefixes once
 *      (a path that already carries a locale is rewritten, not prefixed
 *      again), and it leaves the rest of the path alone: an encoded slug stays
 *      encoded and a query string stays byte-for-byte the caller's, because
 *      the print selection in that query string is the difference between a
 *      framed print and a plain one.
 *
 *   3. **The dictionaries are static and complete.** A dictionary is read from
 *      the build, never from the network, the filesystem, the environment or a
 *      cookie, and a locale without a dictionary throws rather than falling
 *      back to English — a silent English fallback is the failure this whole
 *      slice exists to prevent.
 *
 * The two locales are checked against each other rather than against a
 * hand-written list of keys: a missing key and an extra key are the same
 * failure, and a list would have to be edited every time the copy grows.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  LOCALE_TAGS,
  PUBLIC_LOCALES,
  TURNSTILE_LANGUAGES,
  isLocale,
  type Locale,
} from "../src/domain/i18n/locale.ts";
import { localePath } from "../src/domain/i18n/locale-path.ts";
import {
  DICTIONARIES,
  getDictionary,
} from "../src/components/i18n/dictionaries.ts";
import { API_ERROR_CODES } from "../src/domain/ordering/api-error-codes.ts";
import { CONTACT_FIELD_ERROR_CODES } from "../src/domain/contact/contact-error-codes.ts";
import { CONTACT_ATTEMPT_STATUSES } from "../src/domain/contact/contact-status.ts";

const REPO = path.join(import.meta.dirname, "..");
const DICTIONARIES_SOURCE = fs.readFileSync(
  path.join(REPO, "src/components/i18n/dictionaries.ts"),
  "utf8",
);

/**
 * Every leaf path in a dictionary, dotted and sorted.
 *
 * The parity check below needs the *shape* of a dictionary, not its values:
 * a locale that gained a key the others do not have is as broken as one that
 * lost a key, and both are invisible to a value comparison.
 */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
}

/** The Cyrillic letters of the Bulgarian alphabet, upper and lower case. */
const BULGARIAN_ALPHABET = [
  ...[..."АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ"],
  ...[..."абвгдежзийклмнопрстуфхцчшщъьюя"],
];

/**
 * Every string in a dictionary, however deeply nested.
 *
 * The dictionaries hold a map of locale names inside the language block, so a
 * walk that stopped at the first level would leave those untranslated and
 * unexamined.
 */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
}

test("the registry knows English and Bulgarian, and serves English", () => {
  assert.deepEqual([...LOCALES], ["en", "bg"]);
  assert.equal(DEFAULT_LOCALE, "en");
  // The served list is a subset of the known one: a locale the site does not
  // know cannot be served, and serving one would mean serving a page with no
  // words in it.
  for (const locale of PUBLIC_LOCALES) {
    assert.ok(
      (LOCALES as readonly string[]).includes(locale),
      `${locale} is served but not known`,
    );
  }
  // The integration guard: both known locales are served, now that the page,
  // contact, checkout and SEO slices have landed. `PUBLIC_LOCALES` is still the
  // one line that publishes a locale.
  assert.deepEqual([...PUBLIC_LOCALES], ["en", "bg"]);
});

test("every locale has a formatting tag and an endonym", () => {
  for (const locale of LOCALES) {
    const tag = LOCALE_TAGS[locale];
    assert.ok(tag, `${locale} needs a BCP 47 tag`);
    // The tag's primary subtag is the locale, so a formatter cannot format
    // Bulgarian with an English tag or the other way round.
    assert.equal(tag.split("-")[0], locale);
    assert.ok(LOCALE_NAMES[locale], `${locale} needs its own name`);
  }
  // The names are endonyms: a Bulgarian reader is offered "Български", not
  // "Bulgarian".
  assert.equal(LOCALE_NAMES.bg, "Български");
});

test("the guard accepts a known locale and refuses anything else", () => {
  for (const locale of LOCALES) {
    assert.equal(isLocale(locale), true, `${locale} is a locale`);
  }
  for (const value of ["de", "EN", "en-GB", "", "english", " en", "bg "]) {
    assert.equal(isLocale(value), false, `${JSON.stringify(value)} is not a locale`);
  }
});

test("the path helper prefixes the locale exactly once", () => {
  assert.equal(localePath("en", "/"), "/en");
  assert.equal(localePath("bg", "/"), "/bg");
  assert.equal(localePath("en", "/fine-art"), "/en/fine-art");
  assert.equal(localePath("en", "/prints/a-photo"), "/en/prints/a-photo");
  assert.equal(localePath("en", "/story"), "/en/story");
  assert.equal(localePath("en", "/contact"), "/en/contact");
  assert.equal(localePath("en", "/checkout/success"), "/en/checkout/success");
  // A path that already carries a locale is rewritten, not prefixed twice:
  // this is what makes the language switcher one call.
  assert.equal(localePath("en", "/en/fine-art"), "/en/fine-art");
  assert.equal(localePath("bg", "/en/fine-art"), "/bg/fine-art");
  assert.equal(localePath("en", "/bg/fine-art"), "/en/fine-art");
  assert.equal(localePath("bg", "/bg/fine-art"), "/bg/fine-art");
  // A trailing slash on the locale root is dropped: the site's root is "/en",
  // not "/en/". Two spellings of one URL is a redirect nobody asked for, and a
  // canonical that points at the other one.
  assert.equal(localePath("en", "/en/"), "/en");
  assert.equal(localePath("bg", "/bg/"), "/bg");
});

test("the path helper leaves the route and its tail alone", () => {
  // An encoded slug stays encoded: the slug is a path segment, and decoding it
  // here would produce a URL the router resolves differently.
  assert.equal(
    localePath("en", "/prints/a%20photo%20with%20spaces"),
    "/en/prints/a%20photo%20with%20spaces",
  );
  // A query string is the caller's, byte for byte. The print selection lives
  // in it, and a checkout return carries a session id in it.
  assert.equal(
    localePath("en", "/prints/a-photo?format=framed&size=a4"),
    "/en/prints/a-photo?format=framed&size=a4",
  );
  assert.equal(
    localePath("bg", "/en/checkout/success?session_id=cs_test_123"),
    "/bg/checkout/success?session_id=cs_test_123",
  );
  // A fragment is a tail too.
  assert.equal(localePath("en", "/story#contact"), "/en/story#contact");
  // A route without its leading slash is still a route.
  assert.equal(localePath("en", "fine-art"), "/en/fine-art");
});

test("a segment that only looks like a locale is not one", () => {
  // Two letters followed by more of a word is not a locale segment, and
  // mistaking it for one would strip the first two characters of a real route.
  assert.equal(localePath("en", "/e-store"), "/en/e-store");
  assert.equal(localePath("en", "/ab"), "/en/ab");
});

test("every locale has a dictionary, and no locale has one that is not known", () => {
  for (const locale of LOCALES) {
    assert.ok(DICTIONARIES[locale], `${locale} needs a dictionary`);
  }
  assert.deepEqual(
    Object.keys(DICTIONARIES).sort(),
    [...LOCALES].sort(),
    "a dictionary for a locale the registry does not know is a typo, and a " +
      "missing one is a page with nothing to say",
  );
});

test("every locale's dictionary has the same keys as English's", () => {
  const reference = leafPaths(DICTIONARIES[DEFAULT_LOCALE]);
  assert.ok(reference.length > 0, "the reference dictionary is not empty");
  for (const locale of LOCALES) {
    assert.deepEqual(
      leafPaths(DICTIONARIES[locale]),
      reference,
      `${locale} must have exactly the keys ${DEFAULT_LOCALE} has`,
    );
  }
});

test("every failure code has a sentence in every locale", () => {
  // The copy for a code is keyed by the code, so a code with no sentence
  // would render as an empty line — and a sentence with no code is a sentence
  // nothing can ask for. The compiler holds the shape; this holds the set.
  const apiCodes = Object.values(API_ERROR_CODES).sort();
  const contactCodes = Object.values(CONTACT_ATTEMPT_STATUSES)
    .filter((status) => status !== CONTACT_ATTEMPT_STATUSES.ok)
    .sort();
  const fieldCodes = Object.values(CONTACT_FIELD_ERROR_CODES).sort();
  for (const locale of LOCALES) {
    const copy = DICTIONARIES[locale];
    assert.deepEqual(
      Object.keys(copy.configurator.apiErrors).sort(),
      apiCodes,
      `${locale} must have a sentence for every api failure code`,
    );
    assert.deepEqual(
      Object.keys(copy.contact.errors).sort(),
      contactCodes,
      `${locale} must have a sentence for every failed attempt`,
    );
    assert.deepEqual(
      Object.keys(copy.contact.fieldErrors).sort(),
      fieldCodes,
      `${locale} must have a sentence for every field rejection`,
    );
  }
});

test("the Turnstile widget speaks a plain language code", () => {
  for (const locale of LOCALES) {
    const language = TURNSTILE_LANGUAGES[locale];
    assert.ok(language, `${locale} needs a widget language`);
    // Not a BCP 47 tag: the widget takes "bg", and a tag it does not know
    // ("bg-BG") leaves the challenge in English — an English anti-spam check
    // on a Bulgarian page.
    assert.equal(language.includes("-"), false, language);
    assert.equal(language.split("-")[0], locale);
  }
});

test("the Bulgarian dictionary is Bulgarian, not a copy of the English one", () => {
  const bg = DICTIONARIES.bg;
  assert.notEqual(bg, DICTIONARIES.en);
  // Every string in it, however deeply nested, and every Cyrillic character in
  // every one of them: the thirty letters are the Bulgarian alphabet, and a
  // letter from a neighbouring one is a copy-paste from a translation of a
  // language the site does not speak.
  const letters = new Set(BULGARIAN_ALPHABET);
  const strings = stringLeaves(bg);
  assert.ok(strings.length > 0, "the Bulgarian dictionary has no strings in it");
  for (const value of strings) {
    assert.match(value, /[А-Яа-я]/u, `not in Bulgarian: ${value}`);
    for (const character of value) {
      if (!/[А-Яа-я]/.test(character)) continue;
      assert.ok(
        letters.has(character),
        `"${character}" is not one of the thirty Bulgarian letters: ${value}`,
      );
    }
  }
});

test("a locale without a dictionary throws rather than falling back to English", () => {
  // The lookup is the last place a fallback could hide, and a fallback is
  // exactly what the acceptance criteria forbid: a URL that names Bulgarian
  // and renders English is a page that lies about its own language.
  assert.throws(
    () => getDictionary("de" as unknown as Locale),
    /No dictionary for de/,
  );
  assert.throws(
    () => getDictionary("bg-BG" as unknown as Locale),
    /No dictionary for bg-BG/,
  );
  // The locales that do have one do not throw.
  for (const locale of LOCALES) {
    assert.equal(getDictionary(locale), DICTIONARIES[locale]);
  }
});

test("the dictionary lookup reads nothing at runtime", () => {
  // The dictionary is read from the build. A lookup that read the network,
  // the filesystem, the environment, a cookie or the browser's language could
  // fail on a page that was otherwise fine.
  for (const forbidden of [
    /\bfetch\s*\(/,
    /\bimport\s*\(/,
    /\breadFile/,
    /\bprocess\.env\b/,
    /\bcookies\s*\(/,
    /\bnavigator\./,
    /\bdocument\./,
  ]) {
    assert.doesNotMatch(
      DICTIONARIES_SOURCE,
      forbidden,
      `the dictionary must not read ${forbidden} at runtime`,
    );
  }
  // And the strings it holds are compiled in, not fetched: both locales are
  // in the module.
  assert.match(DICTIONARIES_SOURCE, /const en: Dictionary/);
  assert.match(DICTIONARIES_SOURCE, /const bg: Dictionary/);
});

test("nothing under src/ holds a second list of locales", () => {
  // The acceptance criteria ask for a single registry. A second list is how
  // `/bg` starts serving English on one page while the switcher still offers
  // it on another.
  const registry = path.join(REPO, "src/domain/i18n/locale.ts");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (full === registry) continue;
      const source = fs.readFileSync(full, "utf8");
      if (/["']en["']\s*,\s*["']bg["']/.test(source)) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  walk(path.join(REPO, "src"));
  assert.deepEqual(
    offenders,
    [],
    "only the registry may list the locales; these files list them too",
  );
  // And the registry is the one that holds it.
  assert.match(fs.readFileSync(registry, "utf8"), /LOCALES = \["en", "bg"\]/);
});
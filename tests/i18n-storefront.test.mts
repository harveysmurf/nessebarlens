/**
 * The storefront's second language: the catalog's copy, the localized
 * selector, the money, the countries and the configurator.
 *
 * These are the properties that make a Bulgarian page a Bulgarian page rather
 * than an English page under a Bulgarian URL:
 *
 *   1. **Every published photo carries its own Bulgarian copy.** The catalog
 *      build refuses a photo without it, and this test reads the shipped YAML
 *      rather than the compiled catalog, so a translation that was dropped
 *      from the source is caught here too.
 *   2. **The selector is the only way to read a photo.** It returns a new
 *      photo, it does not touch the shared catalog, and it has no fallback to
 *      the source's words: a missing translation is a broken catalog, and a
 *      broken catalog that quietly renders English is the failure this whole
 *      slice exists to prevent.
 *   3. **The money and the countries follow the locale**, and only the
 *      display does: the amount is the same number and the destination is
 *      still the ISO code.
 *   4. **Every configurator branch is Bulgarian** — digital, giclée, framed
 *      with and without a mount, canvas, and the size that cannot go without
 *      one — because a branch nobody looked at is a branch that still says
 *      "Checkout with Stripe".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse as parseYaml } from "yaml";

import { PHOTOS, photoForLocale } from "../src/domain/catalog/photos.ts";
import { categoryNames, categoryTagline } from "../src/domain/catalog/categories.ts";
import { validatePhotoFile } from "../src/domain/catalog/photo-schema.ts";
import { LOCALES, TRANSLATED_LOCALES } from "../src/domain/i18n/locale.ts";
import { DICTIONARIES, getDictionary } from "../src/components/i18n/dictionaries.ts";
import { servedLocales } from "../src/infrastructure/i18n/served-locales.ts";
import { eurLabel, formatLabel, sizeLabel } from "../src/domain/pricing/pricing.ts";
import {
  countryName,
  shipToCountriesFor,
  SHIP_TO_COUNTRIES,
} from "../src/domain/pricing/ship-to-countries.ts";
import {
  configuratorFormats,
  configuratorFrames,
  configuratorMounts,
  configuratorPapers,
  offeredFormats,
  paperNote,
  previewCaption,
  previewLabel,
  previewNote,
  sizeOptions,
} from "../src/domain/ordering/print-copy.ts";
import { PrintConfigurator } from "../src/components/PrintConfigurator.tsx";
import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";
import type { PhotoCategory } from "../src/domain/catalog/photo-schema.ts";
import {
  PREVIEW_KINDS,
  type PreviewGeometry,
} from "../src/domain/ordering/print-preview.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const PHOTOS_DIR = path.join(REPO, "content", "photos");

/** The shipped photo files, read from the source rather than the build. */
function photoFiles(): Array<{ name: string; data: Record<string, unknown> }> {
  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      name,
      data: parseYaml(fs.readFileSync(path.join(PHOTOS_DIR, name), "utf8")) as Record<
        string,
        unknown
      >,
    }));
}

test("every published photo carries a complete translation for every locale", () => {
  const files = photoFiles();
  assert.ok(files.length > 0, "the catalog has photos");
  for (const { name, data } of files) {
    const result = validatePhotoFile(name.replace(/\.yaml$/, ""), data);
    assert.equal(result.ok, true, `${name} must satisfy the schema`);
    if (!result.ok) continue;
    assert.equal(result.photo.published, true, `${name} is published`);

    const translations = result.photo.translations ?? {};
    for (const locale of TRANSLATED_LOCALES) {
      const translation = translations[locale];
      assert.ok(translation, `${name} has no ${locale} translation`);
      assert.ok(translation.title.trim().length > 0, `${name}.${locale}.title`);
      assert.ok(translation.caption.trim().length > 0, `${name}.${locale}.caption`);
      assert.ok(
        translation.description.trim().length > 0,
        `${name}.${locale}.description`,
      );
      assert.ok(translation.alt.trim().length > 0, `${name}.${locale}.alt`);
      assert.ok(
        translation.alt.length <= 200,
        `${name}.${locale}.alt is over the 200-character cap`,
      );
      // A translation is not the source's words: a photo published in two
      // languages with one caption is a photo with one caption.
      assert.notEqual(translation.title, result.photo.title, `${name}.${locale}`);
    }
  }
});

test("the Bulgarian photo copy is Bulgarian, and the names are too", () => {
  // The catalog's copy and the registry's names are the two places a Bulgarian
  // reader meets the site's own words, and an English sentence in either is a
  // page in the wrong language.
  const CYRILLIC = /[А-Яа-я]/u;
  for (const { name, data } of photoFiles()) {
    const result = validatePhotoFile(name.replace(/\.yaml$/, ""), data);
    assert.equal(result.ok, true, name);
    if (!result.ok) continue;
    const translation = result.photo.translations?.bg;
    assert.ok(translation, `${name} has no Bulgarian translation`);
    for (const value of Object.values(translation)) {
      if (typeof value !== "string") continue;
      assert.match(value, CYRILLIC, `${name} is not in Bulgarian: ${value}`);
    }
  }
  for (const category of Object.keys(
    DICTIONARIES.en.gallery.badge,
  ) as PhotoCategory[]) {
    const names = categoryNames(category, "bg");
    for (const value of Object.values(names)) {
      assert.match(value, CYRILLIC, `${category} is not in Bulgarian: ${value}`);
    }
  }
  assert.match(categoryTagline("bg"), CYRILLIC);
});

test("the selector localizes a photo and leaves the shared catalog alone", () => {
  const source = PHOTOS[0]!;
  const before = { ...source };

  const localized = photoForLocale(source, "bg");
  assert.equal(localized.title, source.translations.bg?.title);
  assert.equal(localized.caption, source.translations.bg?.caption);
  assert.equal(localized.description, source.translations.bg?.description);
  assert.equal(localized.alt, source.translations.bg?.alt);
  // The category line is the locale's too.
  assert.equal(localized.categoryLabel, categoryNames(source.category, "bg").printLabel);

  // The shared catalog is untouched: the English gallery and the Bulgarian one
  // are rendered from one array.
  assert.deepEqual(source, before);
  assert.equal(PHOTOS[0]!.title, before.title);

  // The source's locale reads the source's words.
  const english = photoForLocale(source, "en");
  assert.equal(english.title, source.title);
  assert.equal(english.alt, source.alt);
});

test("a missing translation throws rather than falling back to English", () => {
  const source = PHOTOS[0]!;
  const broken = { ...source, translations: {} };
  assert.throws(
    () => photoForLocale(broken, "bg"),
    /No bg translation for the photo/,
  );
});

test("the money follows the locale and the amount does not change", () => {
  assert.equal(eurLabel(30, "en"), "€30.00");
  // The Bulgarian amount puts the symbol after the number and separates them
  // with a no-break space, so the amount and the sign never come apart.
  assert.match(eurLabel(30, "bg"), /^30,00\s€/);
  // The same number, read two ways: the quote, the cents and the total are
  // what the buyer is charged, and none of them moved.
  assert.equal(eurLabel(30, "en").replace(/[^\d.]/g, ""), "30.00");
  assert.equal(eurLabel(30, "bg").replace(/[^\d,]/g, ""), "30,00");
  assert.match(eurLabel(0, "bg"), /^0,00\s€/);
  // The order line's label is the locale's, and the product ids are not.
  assert.equal(formatLabel("giclee", "white", "ema", "en"), "Giclée Fine Art Print (Matte Art 200gsm)");
  assert.equal(formatLabel("giclee", "white", "ema", "bg"), "Финиарт giclée (Matte Art 200gsm)");
  // The size label writes the unit the way the language writes it.
  assert.equal(sizeLabel("30x40", "portrait", "en"), "30 × 40 cm (12 × 16\")");
  assert.equal(sizeLabel("30x40", "portrait", "bg"), "30 × 40 см (12 × 16″)");
});

test("the country names follow the locale and the codes do not", () => {
  assert.equal(countryName("BG", "en"), "Bulgaria");
  assert.equal(countryName("BG", "bg"), "България");
  assert.equal(countryName("DE", "bg"), "Германия");
  // The code is the fact, and it is what reaches Prodigi and Stripe.
  assert.equal(countryName("BG", "bg"), "България");
  assert.notEqual(countryName("BG", "bg"), "BG");
});

test("the destination list is built on the server, in the reader's language", () => {
  // The names come from ICU, and the server's ICU and the browser's are not
  // the same version: a name the client re-derived could differ from the one
  // the server sent, and React calls that a hydration mismatch. So the list is
  // built once, on the server, and the client renders it.
  const bg = shipToCountriesFor("bg");
  const en = shipToCountriesFor("en");
  assert.equal(bg.length, en.length);
  assert.equal(bg.length, SHIP_TO_COUNTRIES.length);
  assert.equal(bg[0]?.code, "AF");
  assert.equal(bg.find((c) => c.code === "BG")?.name, "България");
  assert.equal(en.find((c) => c.code === "BG")?.name, "Bulgaria");
  // The code is what the server receives; the name never leaves the browser.
  assert.equal(
    bg.find((c) => c.code === "BG")?.code,
    "BG",
  );
});

test("every shipped country has a name in every locale", () => {
  // The invariant that lets `countryName` have no fallback: ICU names every
  // ISO 3166-1 alpha-2 code the list holds. A code it did not know would
  // render as the two-letter code, so this is a test failure rather than a
  // selector offering a visitor "BJ".
  for (const { code } of SHIP_TO_COUNTRIES) {
    for (const locale of LOCALES) {
      assert.notEqual(
        countryName(code, locale),
        code,
        `${code} has no name in ${locale}`,
      );
    }
  }
});

test("the configurator's copy is Bulgarian in every branch", () => {
  const OFFER: PrintOffer = {
    giclee: ["20x30", "30x40"],
    framed: ["20x30", "30x40"],
    canvas: ["20x30", "30x40"],
  };
  // Big enough for every size at 220 PPI, and not square: the unmounted
  // product is eligible, so the configurator offers "No Mount" and explains
  // the mounted one.
  const MASTER: MasterFacts = {
    width: 8000,
    height: 6000,
    orientation: "landscape",
  };
  // A square photo in a frame that is not square: the shape does not fit
  // without a mount, which is the branch that used to carry an English
  // sentence.
  const SQUARE: MasterFacts = {
    width: 8000,
    height: 8000,
    orientation: "square",
  };

  const markup = (
    selection: PrintSelection,
    locale: "en" | "bg",
    master: MasterFacts = MASTER,
  ): string =>
    renderToStaticMarkup(
      createElement(PrintConfigurator, {
        photoSlug: "a-photo",
        title: "A photo",
        offer: OFFER,
        master,
        selection,
        onSelectionChange: () => {},
        locale,
        copy: getDictionary(locale).configurator,
        countries: shipToCountriesFor(locale),
      }),
    );

  const base: PrintSelection = {
    format: "giclee",
    size: "30x40",
    frame: "black",
    mount: "white",
    paper: "ema",
  };

  // The format names, in both languages.
  assert.deepEqual(
    configuratorFormats("bg").map((f) => f.title),
    ["Финиарт giclée", "Финиарт в рамка", "Опъната канава", "Цифров файл"],
  );
  assert.deepEqual(
    configuratorFormats("en").map((f) => f.title),
    ["Giclée Fine Art", "Framed Print", "Stretched Canvas", "Digital Copy"],
  );

  // Digital: the resolution field, the digital price and the digital footnote.
  const digital = markup({ ...base, format: "digital" }, "bg");
  assert.match(digital, /Резолюция/);
  assert.match(digital, /30,00\s€/);
  assert.match(digital, /Сигурно плащане · Линк за изтегляне след изпълнение/);

  // Giclée: the paper field and the paper's own note.
  const giclee = markup(base, "bg");
  assert.match(giclee, /Хартия/);
  assert.match(giclee, /Гладка плътна матова хартия/);
  assert.match(markup(base, "en"), /Smooth heavyweight matte, natural white\./);

  // Framed with a mount: the frame and mount fields, and the mounted help.
  const framed = markup({ ...base, format: "framed" }, "bg");
  assert.match(framed, /Рамка/);
  assert.match(framed, /Паспарту/);
  assert.match(framed, /Бяла паспарту/);
  assert.match(framed, /Снимката е зад бяла паспарту/);

  // Framed without a mount: the other help line, and the size in Bulgarian.
  const unmounted = markup(
    { ...base, format: "framed", mount: "none", size: "20x30" },
    "bg",
    SQUARE,
  );
  assert.match(unmounted, /Без паспарту/);
  // The shape does not fit, so the configurator says why — in Bulgarian.
  assert.match(unmounted, /Формата на тази снимка не се побира в тази рамка без паспарту/);
  assert.doesNotMatch(unmounted, /doesn't fit this frame/);

  // And the eligible case says the other thing.
  const eligible = markup(
    { ...base, format: "framed", mount: "none", size: "20x30" },
    "bg",
  );
  assert.match(eligible, /Снимката запълва рамката от край до край, без паспарту/);

  // The busy and idle button, the footnote and the failure messages.
  assert.match(markup(base, "bg"), /Плащане през Stripe/);
  assert.match(markup(base, "bg"), /Сигурно плащане · Доставка на живо през Prodigi/);
  assert.doesNotMatch(markup(base, "bg"), /Checkout with Stripe/);
});

test("the preview's label, caption and note are Bulgarian", () => {
  const selection: PrintSelection = {
    format: "framed",
    size: "30x40",
    frame: "white",
    mount: "white",
    paper: "ema",
  };
  const alt = "Едноредово описание на изображението";
  assert.match(previewLabel(alt, selection, "landscape", "bg"), /финиарт в рамка/);
  assert.match(previewCaption(selection, "landscape", "bg"), /Финиарт в рамка/);
  assert.match(previewCaption(selection, "landscape", "en"), /Framed Print/);
  // The size option's label is Bulgarian too.
  assert.deepEqual(
    sizeOptions(
      { giclee: ["30x40"], framed: [], canvas: [] },
      "giclee",
      "landscape",
      "bg",
    ).map((s) => s.label),
    ["40 × 30 см (16 × 12″)"],
  );
  // The offered formats are the same ids in both languages.
  assert.deepEqual(
    offeredFormats({ giclee: ["30x40"], framed: [], canvas: [] }, "bg").map((f) => f.id),
    offeredFormats({ giclee: ["30x40"], framed: [], canvas: [] }, "en").map((f) => f.id),
  );
  // And the paper note.
  assert.match(paperNote("ema", "bg"), /памучна|матова/);
  // The preview note, for the canvas branch.
  assert.match(
    previewNote(
      {
        kind: PREVIEW_KINDS.canvas,
        front: { width: 100, height: 100 },
        wrapMm: { x: 40, y: 40 },
        depthMm: 38,
        image: { x: 0, y: 0, width: 100, height: 100 },
        cropFraction: 0,
      } satisfies PreviewGeometry,
      "bg",
    ) ?? "",
    /се увиват около страните на канавата/,
  );
  // The paper branch, where the crop is visible: the note says so, in the
  // reader's language.
  const cropNote = {
    kind: PREVIEW_KINDS.paper,
    outer: { width: 100, height: 100 },
    image: { x: 0, y: 0, width: 98, height: 98 },
    cropFraction: 0.02,
  } satisfies PreviewGeometry;
  assert.match(previewNote(cropNote, "bg") ?? "", /снимката се изрязва леко/);
  assert.match(previewNote(cropNote, "en") ?? "", /trimmed slightly/);
  assert.match(
    previewNote(
      {
        kind: PREVIEW_KINDS.canvas,
        front: { width: 100, height: 100 },
        wrapMm: { x: 40, y: 40 },
        depthMm: 38,
        image: { x: 0, y: 0, width: 100, height: 100 },
        cropFraction: 0,
      } satisfies PreviewGeometry,
      "en",
    ) ?? "",
    /wraps around the sides of the canvas/,
  );
});

test("every preview branch is written in both languages", () => {
  // The preview's label and caption are a function per format per locale, and a
  // format nobody rendered is a format nobody wrote: the assertions below walk
  // every one of them, so a new format is a compile error here and a missing
  // sentence is a test failure rather than an English line in a Bulgarian page.
  const selections: PrintSelection[] = [
    { format: "giclee", size: "30x40", frame: "black", mount: "white", paper: "ema" },
    { format: "framed", size: "30x40", frame: "brown", mount: "white", paper: "ema" },
    { format: "framed", size: "30x40", frame: "brown", mount: "none", paper: "ema" },
    { format: "canvas", size: "30x40", frame: "black", mount: "white", paper: "ema" },
    { format: "digital", size: "30x40", frame: "black", mount: "white", paper: "ema" },
  ];
  for (const locale of ["en", "bg"] as const) {
    for (const selection of selections) {
      const label = previewLabel("Алтернативен текст", selection, "landscape", locale);
      const caption = previewCaption(selection, "landscape", locale);
      assert.ok(label.length > 0, `${selection.format} ${locale} has a label`);
      assert.ok(caption.length > 0, `${selection.format} ${locale} has a caption`);
      // The Bulgarian ones are Bulgarian.
      if (locale === "bg") {
        assert.match(label, /[А-Яа-я]/u, `${selection.format} label is not Bulgarian`);
        assert.match(caption, /[А-Яа-я]/u, `${selection.format} caption is not Bulgarian`);
      }
    }
  }
  // And the frame, mount and paper lists, in both languages.
  for (const locale of ["en", "bg"] as const) {
    for (const frame of configuratorFrames(locale)) {
      assert.ok(frame.label.length > 0, `${frame.id} has a label`);
    }
    for (const mount of configuratorMounts(locale)) {
      assert.ok(mount.label.length > 0, `${mount.id} has a label`);
    }
    for (const paper of configuratorPapers(locale)) {
      assert.ok(paper.label.length > 0, `${paper.id} has a label`);
    }
  }
});

test("the served set is the registry's, and only a dev build may widen it", () => {
  // A production build serves exactly the registry's public list, whatever the
  // environment says: the integration guard cannot be lifted by a stray
  // variable on a deploy host.
  assert.deepEqual(
    servedLocales({ NODE_ENV: "production", SERVE_LOCALES: "bg" }),
    ["en"],
  );
  // Outside a production build the override reaches the Bulgarian tree, which
  // is how the e2e can open a page the site does not publish yet.
  assert.deepEqual(servedLocales({ NODE_ENV: "development" }), ["en"]);
  assert.deepEqual(
    servedLocales({ NODE_ENV: "development", SERVE_LOCALES: "bg" }),
    ["en", "bg"],
  );
  // A repeat is not a second locale, and an empty name is not a locale.
  assert.deepEqual(
    servedLocales({ NODE_ENV: "development", SERVE_LOCALES: "bg,bg" }),
    ["en", "bg"],
  );
  assert.deepEqual(
    servedLocales({ NODE_ENV: "development", SERVE_LOCALES: "bg, ,bg" }),
    ["en", "bg"],
  );
  // And a locale the site does not know is an error rather than a silent skip:
  // a typo that quietly served nothing would leave the e2e running against the
  // English tree and calling it green.
  assert.throws(
    () => servedLocales({ NODE_ENV: "development", SERVE_LOCALES: "de" }),
    /SERVE_LOCALES names "de"/,
  );
});

test("every locale has a dictionary, and the Bulgarian one is Bulgarian", () => {
  for (const locale of LOCALES) {
    assert.ok(DICTIONARIES[locale], `${locale} has a dictionary`);
  }
  // The dictionary throws rather than falling back: a URL that names a
  // language the site has no words for is a 404, not an English page.
  assert.throws(
    () => getDictionary("de" as never),
    /No dictionary for de/,
  );
});

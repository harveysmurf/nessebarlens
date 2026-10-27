/**
 * The vendored Cyrillic subsets, and the proof that they carry Bulgarian.
 *
 * "The font file exists" is not the claim. A subset that was cut without the
 * Bulgarian alphabet — or cut with the Latin letters and not the Cyrillic
 * ones, which is what a naive Latin-unicode-range subset does — is a file that
 * loads, passes a file-existence check and renders nothing. So the glyphs are
 * read out of the fonts themselves, with the same parser the browser uses.
 *
 * The three properties held here:
 *
 *   1. **The Bulgarian alphabet is in the font.** Every letter of it, upper
 *      and lower case, has a glyph in each of the three Cyrillic files.
 *   2. **The Latin rendering is intact.** The Latin subsets are still on disk
 *      and still carry Latin glyphs, and they still carry no Cyrillic — which
 *      is *why* the stylesheet needs two families in a stack rather than one
 *      family with two files in it.
 *   3. **The build stays offline.** Nothing is fetched at build time or at
 *      runtime, and the weight range the layout declares is the range the
 *      font actually carries, so a weight the layout asks for is a weight the
 *      browser can render.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO = path.join(import.meta.dirname, "..");

/**
 * fontkit has no TypeScript declarations, and the suite's typecheck gate is
 * strict. The package is CommonJS, so it is loaded through `createRequire`
 * and given a shape by hand — a shape that says exactly what this file asks
 * of it, so a wrong call is a type error rather than an `any` that flows.
 */
type Font = {
  familyName: string;
  numGlyphs: number;
  variationAxes: Record<string, { min: number; max: number; default: number }>;
  hasGlyphForCodePoint(codePoint: number): boolean;
};

type Fontkit = {
  openSync(file: string): Font;
};

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as Fontkit;

/** The Bulgarian alphabet: thirty letters, upper and lower case. */
const BULGARIAN = [
  ..."АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ",
  ..."абвгдежзийклмнопрстуфхцчшщъьюя",
];

/** The Cyrillic files, and the weight range the layout declares for each. */
const CYRILLIC_FILES = [
  {
    file: "src/fonts/inter/inter-cyrillic-variable-normal.woff2",
    family: "inter",
    variable: "--font-inter-cyrillic",
    weight: "100 900",
  },
  {
    file: "src/fonts/cormorant-garamond/cormorant-garamond-cyrillic-variable-normal.woff2",
    family: "cormorant",
    variable: "--font-cormorant-cyrillic",
    weight: "300 700",
  },
  {
    file: "src/fonts/cormorant-garamond/cormorant-garamond-cyrillic-variable-italic.woff2",
    family: "cormorant",
    variable: "--font-cormorant-cyrillic",
    weight: "300 700",
  },
];

/** The Latin files the layout already shipped, which must all still exist. */
const LATIN_FILES = [
  "src/fonts/inter/inter-latin-200-normal.woff2",
  "src/fonts/inter/inter-latin-300-normal.woff2",
  "src/fonts/inter/inter-latin-400-normal.woff2",
  "src/fonts/inter/inter-latin-500-normal.woff2",
  "src/fonts/inter/inter-latin-600-normal.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-300-normal.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-300-italic.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-400-normal.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-400-italic.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-500-normal.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-500-italic.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-600-normal.woff2",
  "src/fonts/cormorant-garamond/cormorant-garamond-latin-600-italic.woff2",
];

const open = (relative: string): Font =>
  fontkit.openSync(path.join(REPO, relative));

test("every Cyrillic file carries the whole Bulgarian alphabet", () => {
  for (const { file } of CYRILLIC_FILES) {
    const font = open(file);
    const missing = BULGARIAN.filter(
      (letter) => !font.hasGlyphForCodePoint(letter.codePointAt(0)!),
    );
    assert.deepEqual(
      missing,
      [],
      `${file} is missing ${missing.length} Bulgarian letter(s): ${missing.join("")}`,
    );
  }
});

test("the Cyrillic files are the variable fonts they claim to be", () => {
  for (const { file, weight } of CYRILLIC_FILES) {
    const font = open(file);
    const axis = font.variationAxes.wght;
    assert.ok(axis, `${file} must have a weight axis`);
    // The range the layout declares is the range the file carries: a layout
    // asking for a weight the font does not have renders the nearest one it
    // does, silently.
    const [min, max] = weight.split(" ").map(Number);
    assert.equal(axis.min, min, `${file} starts at ${min}`);
    assert.equal(axis.max, max, `${file} ends at ${max}`);
  }
});

test("the Latin subsets are retained and still render Latin", () => {
  for (const file of LATIN_FILES) {
    assert.ok(
      fs.existsSync(path.join(REPO, file)),
      `${file} must be retained: the Bulgarian subset does not replace it`,
    );
    const font = open(file);
    for (const character of "AaZz09") {
      assert.ok(
        font.hasGlyphForCodePoint(character.codePointAt(0)!),
        `${file} must still render ${character}`,
      );
    }
  }
});

test("the Latin subset carries no Cyrillic, so Bulgarian falls through to the other family", () => {
  // A browser walks the font stack per character and takes the first family
  // that has the glyph. The Latin subset has no Bulgarian letter at all, so
  // every Bulgarian character falls through to the Cyrillic family — which is
  // the whole reason the stack carries two.
  const latin = open("src/fonts/inter/inter-latin-400-normal.woff2");
  for (const letter of BULGARIAN) {
    assert.equal(
      latin.hasGlyphForCodePoint(letter.codePointAt(0)!),
      false,
      "the Latin subset must not carry Cyrillic, or the second family is dead weight",
    );
  }
  // The Cyrillic file is a subset of the family, not a second copy of it:
  // two whole families would double the weight the site ships.
  const cyrillic = open("src/fonts/inter/inter-cyrillic-variable-normal.woff2");
  assert.ok(
    cyrillic.numGlyphs < latin.numGlyphs / 2,
    `the Cyrillic subset carries ${cyrillic.numGlyphs} glyphs against the Latin file's ${latin.numGlyphs}`,
  );
});

test("the licence files are retained", () => {
  for (const file of [
    "src/fonts/inter/LICENSE",
    "src/fonts/cormorant-garamond/LICENSE",
  ]) {
    assert.ok(
      fs.existsSync(path.join(REPO, file)),
      `${file} must be retained alongside the subsets`,
    );
  }
});

test("the layout declares both families, and applies both", () => {
  const layout = fs.readFileSync(
    path.join(REPO, "src/app/[locale]/layout.tsx"),
    "utf8",
  );
  // The binding each family is declared under, so the check below asks the
  // layout the same question it answers: is the variable the stylesheet names
  // the variable the document carries?
  const bindings = new Map<string, string>();
  for (const block of layout.matchAll(
    /const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g,
  )) {
    const variable = block[2]?.match(/variable:\s*"(--[\w-]+)"/)?.[1];
    if (variable) bindings.set(variable, block[1] as string);
  }

  for (const { file, variable, weight } of CYRILLIC_FILES) {
    assert.ok(
      layout.includes(path.basename(file)),
      `the layout must declare ${file}`,
    );
    assert.ok(
      layout.includes(`"${variable}"`),
      `the layout must expose ${variable}`,
    );
    assert.ok(
      layout.includes(`weight: "${weight}"`),
      `the layout must declare the weight range ${weight} for ${file}`,
    );
    // The variables are applied to the document, or the browser never sees
    // the families the stylesheet names.
    const binding = bindings.get(variable);
    assert.ok(binding, `the layout must bind ${variable}`);
    assert.match(
      layout,
      new RegExp(`\\$\\{${binding}\\.variable\\}`),
      `${variable} must be applied to the body`,
    );
  }
});

test("the stylesheet walks the Latin family, then the Cyrillic one, then the system", () => {
  const css = fs.readFileSync(
    path.join(REPO, "src/app/globals.css"),
    "utf8",
  );
  const sans = css.match(/--font-sans:\s*([^;]+);/)?.[1] ?? "";
  const serif = css.match(/--font-serif:\s*([^;]+);/)?.[1] ?? "";

  // The order is the fallback rule: a browser walks the list per character
  // and takes the first family that has the glyph.
  const sansParts = sans.split(",").map((part) => part.trim());
  assert.equal(sansParts[0], "var(--font-inter)");
  assert.equal(sansParts[1], "var(--font-inter-cyrillic)");
  assert.ok(
    sansParts.slice(2).some((part) => part.includes("sans-serif")),
    "the stack must end in a generic family",
  );

  const serifParts = serif.split(",").map((part) => part.trim());
  assert.equal(serifParts[0], "var(--font-cormorant)");
  assert.equal(serifParts[1], "var(--font-cormorant-cyrillic)");
  assert.ok(
    serifParts.slice(2).some((part) => part.includes("serif")),
    "the stack must end in a generic family",
  );
});

test("no font is fetched from the network", () => {
  // The build has to work offline, and a runtime fetch would be a page that
  // renders in a fallback font until — or unless — the network answers.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (fs.readFileSync(full, "utf8").includes("next/font/google")) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  walk(path.join(REPO, "src"));
  assert.deepEqual(offenders, [], "these files fetch a font from the network");
});

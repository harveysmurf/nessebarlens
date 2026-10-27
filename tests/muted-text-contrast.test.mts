/**
 * #423 — the muted-text colour, and the contrast arithmetic behind it.
 *
 * `text-stone-400` is `#a8a29e`. The page background is `--gallery-50`,
 * `#faf8f5`, and the ratio is **2.38:1** against WCAG AA's 4.5:1 for normal
 * text. It was used for real text in 14 places, most of it at `text-[10px]` —
 * small enough to be normal text, not large — and the photo caption was the
 * worst of them: the text under every photo in every gallery, which is what a
 * visitor reads to decide what they are looking at.
 *
 * 14 sites that agree on a value which fails is the argument for changing the
 * value. `stone-500` (`#78716c`) is 4.53:1, and there is no step between the two
 * on the ramp — `stone-450` does not exist and the interpolated values in
 * between (3.68 at `#86807b`, 3.93 at `#827b76`) all fail. So this was a binary,
 * and the owner picked `stone-500`.
 *
 * Three things are held here, and each one is pinned in the way it can break:
 *
 * - **the ratio is computed, not asserted as a number.** A test that asserts
 *   "4.53" passes unchanged when the background moves, which is the failure this
 *   value is most exposed to: 4.53 leaves 0.03 to spare, so a background change
 *   re-breaks it silently. The surface is read out of `globals.css` instead, so
 *   changing `--gallery-50` fails here rather than in someone's browser.
 * - **the hex is the one the site ships.** Tailwind v4 publishes its palette as
 *   `oklch`, and converting back to sRGB is lossy — the published lightness is
 *   rounded to one decimal, which moves a channel by one. So the assertion is on
 *   a hex, and a separate check converts Tailwind's own `--color-stone-500` and
 *   requires it to land within a channel or two, which ties the two together
 *   without pretending the conversion is exact.
 * - **the failing value is gone, and the guard is general.** Not "stone-400 is
 *   used at 14 sites" — a count that a 15th site breaks loudly and a rename
 *   breaks silently. Every `text-stone-N` in `src/` is checked against the page
 *   background, so the next person to reach for a lighter step fails here. At
 *   these thresholds the oklch conversion's one-channel error is irrelevant: the
 *   values being separated are 2.38 and 4.53, not 4.49 and 4.51.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { contrast, oklchToHex, parseHex } from "./contrast.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** WCAG 2.2 AA for normal text. `text-[10px]` is normal text, not large. */
const AA_NORMAL_TEXT = 4.5;

/** The value chosen for muted text. See the header for why it is this one. */
const MUTED_HEX = "#78716c";

/** The two surfaces the muted text is declared against. */
const WHITE_HEX = "#ffffff";

function sourceOf(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function srcFiles(dir = path.join(ROOT, "src")): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...srcFiles(full));
    else if (/\.[cm]?tsx?$/.test(name)) found.push(full);
  }
  return found;
}

/**
 * Every `className` value in a file, as strings.
 *
 * Walks the whole initializer rather than reading the attribute's own literal,
 * because a className is often a template whose branches are string literals of
 * their own — `${cond ? "border-stone-400" : "bg-white"}` puts the class in a
 * conditional, not in the template's text. Reading only the head and the spans
 * misses every one of those.
 *
 * AST rather than regex so that a comment quoting `"text-stone-400"` is not
 * mistaken for a use of it — which is exactly how the first version of the test
 * below reported `PhotoCard.tsx` as still failing, on the strength of a comment
 * this change had just added explaining that it no longer failed.
 */
function classNameTokens(source: ts.SourceFile): string[] {
  const tokens: string[] = [];

  /** Every string literal inside a value — the only way a className can spell one. */
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      tokens.push(node.text);
      return;
    }
    // A template's head and middle are their own node kinds, not string literals,
    // so their text has to be collected explicitly or every interpolated class
    // is lost.
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokens.push(node.text);
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "className" && node.initializer) {
      collect(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tokens;
}

// --- colour arithmetic, from the WCAG and CSS Color 4 definitions -----------

/** The page background, read from the declaration rather than assumed. */
function pageBackground(): string {
  const declared = sourceOf("src/app/globals.css").match(/--gallery-50:\s*(#[0-9a-f]{6})/i);
  assert.ok(declared, "--gallery-50 should be declared as a hex in globals.css");
  return declared[1];
}

/** Tailwind v4's own value for `--color-<name>`, from the compiled stylesheet. */
function tailwindColor(name: string): string | undefined {
  const fromTheme = sourceOf("src/app/globals.css").match(
    new RegExp(`--color-${name}:\\s*([^;]+);`),
  );
  if (fromTheme) return fromTheme[1].trim();

  const oklch = sourceOf("node_modules/tailwindcss/theme.css").match(
    new RegExp(`--color-${name}:\\s*oklch\\(([^)]+)\\)`),
  );
  if (!oklch) return undefined;
  const [l, c, h] = oklch[1].split(/\s+/);
  // Tailwind writes lightness as a percentage; oklch() takes 0–1. Parsing "55.3%"
  // as 55.3 clamps every channel to white, which is a very quiet way to be wrong.
  const lightness = Number.parseFloat(l) / (l.endsWith("%") ? 100 : 1);
  return oklchToHex(lightness, Number.parseFloat(c), Number.parseFloat(h));
}

// --- the assertions --------------------------------------------------------

test("the muted value clears AA on every surface it is used against", () => {
  // The whole of #423, as arithmetic. 4.53 on the page background leaves 0.03 to
  // spare, so the number is recomputed from the declared surface rather than
  // pinned — a background change that re-breaks this fails here, not in a browser.
  const backgrounds: Record<string, string> = {
    "the page background": pageBackground(),
    "the white order card": WHITE_HEX,
  };

  const results = Object.entries(backgrounds).map(([label, bg]) => {
    const ratio = contrast(MUTED_HEX, bg);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `${MUTED_HEX} on ${label} (${bg}) is ${ratio.toFixed(2)}:1, below WCAG AA ` +
        `for normal text (${AA_NORMAL_TEXT}:1). #423 chose this value precisely ` +
        `because it passes; a different step does not.`,
    );
    return `${label}: ${ratio.toFixed(2)}:1`;
  });

  // Recorded so the margin is visible in CI output rather than only here.
  console.log(`muted text ${MUTED_HEX} — ${results.join(", ")}`);
});

test("the hex above is the colour Tailwind actually ships", () => {
  // The assertion above is on a hand-written hex; this is what stops that from
  // drifting away from the stylesheet. Tailwind publishes oklch with lightness
  // rounded to one decimal, so the round trip moves a channel by about one —
  // close enough to catch a changed palette, not a claim of exactness.
  const shipped = tailwindColor("stone-500");
  assert.ok(shipped, "Tailwind should publish a stone-500 colour");

  const [r1, g1, b1] = parseHex(MUTED_HEX);
  const [r2, g2, b2] = parseHex(shipped);
  const drift = Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
  assert.ok(
    drift <= 2,
    `stone-500 ships as ${shipped}, but this test asserts ${MUTED_HEX} ` +
      `(worst channel differs by ${drift}). If Tailwind's palette moved, ` +
      `re-derive the value and check the ratio still passes.`,
  );
});

/**
 * The one `text-stone-*` in src/ that is not declared against the page
 * background.
 *
 * The hero caption sits on `from-gallery-900/80`, a dark gradient over the hero
 * photo, so light text there is the correct choice — `stone-300` on `--gallery-900`
 * is 12.11:1, and on the lightest background the gradient can composite to it is
 * still 7.84:1. Read it against the page background and it looks like a 1.41:1
 * failure, which is exactly what the first version of this test reported. The
 * surface a foreground is declared for is part of its declaration, and a check
 * that assumes one background for the whole codebase is not a general check.
 */
const OVER_DARK_SURFACE: Record<string, string> = {
  // key: `file: text-stone-N`, value: the surface it is really declared against
  "src/app/[locale]/page.tsx: text-stone-300": "--gallery-900",
};

test("no muted text in src/ falls below AA on the surface it is declared for", () => {
  // The guard #423 asked for, generalised: instead of counting the sites that
  // were fixed, check every stone foreground the code declares. A 15th site
  // added with `text-stone-400` — or `text-stone-300` — fails here.
  //
  // Read from the AST rather than the text, because a comment mentioning the old
  // value is not a use of it. That is not hypothetical: this file's sibling
  // `gallery-tiles.test.mts` was, for a while, satisfying its own assertion from
  // its own source, because the string it was looking for appeared in the string
  // that searched for it.
  const pageBackgroundHex = pageBackground();
  const declared = sourceOf("src/app/globals.css");
  const offenders: string[] = [];

  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relative,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    for (const token of classNameTokens(source)) {
      const match = token.match(/\btext-stone-(\d{3})\b/);
      if (!match) continue;

      const step = match[1];
      const hex = tailwindColor(`stone-${step}`);
      assert.ok(hex, `no stone-${step} in the Tailwind theme, but src/ uses it`);

      // The surface this particular foreground is declared against.
      const key = `${relative}: text-stone-${step}`;
      const exception = OVER_DARK_SURFACE[key];
      const background = exception
        ? declared.match(new RegExp(`${exception}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]
        : pageBackgroundHex;
      assert.ok(background, `could not resolve the surface for ${key}`);

      const ratio = contrast(hex, background);
      if (ratio < AA_NORMAL_TEXT) offenders.push(`${key} on ${background} (${ratio.toFixed(2)}:1)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these fail WCAG AA for normal text:\n  ${offenders.join("\n  ")}`,
  );
});

test("the one remaining stone-400 is a border, not text", () => {
  // #423 is about text. One `stone-400` legitimately remains — a hover border in
  // the print configurator — and a bare "zero occurrences" assertion would either
  // fail on it or tempt someone to darken a border for no reason. Named here so
  // that the claim "the failing value is gone" is scoped honestly, and so that
  // turning this border into text fails rather than passing unnoticed.
  const uses: string[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relative,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const token of classNameTokens(source)) {
      for (const match of token.matchAll(/[\w:/.\[\]-]*stone-400/g)) uses.push(`${relative}: ${match[0]}`);
    }
  }

  assert.deepEqual(
    uses,
    ["src/components/PrintConfigurator.tsx: hover:border-stone-400"],
    `stone-400 should now appear only as that hover border:\n  ${uses.join("\n  ")}`,
  );
});
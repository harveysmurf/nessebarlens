/**
 * #422 — one `<PhotoTile>`, not three hand-written boxes. And #409's frame bug,
 * which is what the tile having to be one box was about.
 *
 * Three call sites rendered "a photo in a fixed-ratio box, cropped to fill, with
 * a letterbox backdrop" by hand, and they had drifted: two had a
 * `bg-stone-900 p-1` film frame and one had `bg-stone-200`. That padding is what
 * #409 reported as a 4px black border around every film photo — Tailwind's
 * preflight is `box-sizing: border-box`, so padding on the box shrinks the
 * content box and leaves a ring of the tile's background on all four edges, while
 * the `object-cover` image already fills that content box exactly.
 *
 * The tests here used to read the three call sites and pin the *absence* of a
 * padding branch in each. That worked and stopped the bug, but it could not stop
 * the three boxes drifting again — there was still one definition per call site
 * to drift. There is one now, in `PhotoTile`, so the assertions moved with them.
 *
 * What needs holding, and what each one is actually able to catch:
 *
 * - **the tile is the only tile** — proven by scanning every source file for an
 *   aspect-ratio + `overflow-hidden` wrapper, so hand-writing a fourth box fails
 *   instead of quietly becoming the new place the copies disagree;
 * - **the box draws no frame** — the #409 property, on the one file that now
 *   owns the box;
 * - **the film special case survived the extraction** — the backdrop and the
 *   colour filter are inside the tile now, so dropping them there is invisible
 *   everywhere else and needs an assertion here;
 * - **every class the tile can emit actually compiles** — this is the one that
 *   bit during the extraction. `aspect-[${ratio}]` and `duration-${duration}` are
 *   template literals, and Tailwind scans source *text*, so both produced zero
 *   CSS: no error, no type complaint, and a tile with no aspect ratio. The fix
 *   is literal class maps; the guard compiles the real stylesheet and asks
 *   whether the classes exist, which is the only version of the question that
 *   cannot be satisfied by a plausible-looking source string.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const TILE = "src/components/PhotoTile.tsx";

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
 * The className of the element wrapping the image in the tile.
 *
 * Handles both spellings a tile can use: a static string (a card styled
 * identically for every photo) and a template literal (a tile that still
 * branches). Which one the tile uses is itself an assertion below, so this
 * returns both parts and lets the caller judge.
 */
function tileWrapper(source: string): { static?: string; dynamic?: string } {
  // The tile wrapper carries an aspect ratio and clips its overflow; that pair
  // is what makes the box the thing the image is measured against.
  const dynamic = source.match(/className=\{`([^`]*RATIO_CLASS[^`]*)`\}/);
  if (dynamic) return { dynamic: dynamic[1] };

  const literal = source.match(/className="([^"]*aspect-\[[^"]*overflow-hidden[^"]*)"/);
  if (literal) return { static: literal[1] };

  assert.fail("no aspect-ratio tile wrapper found in PhotoTile");
}

test("PhotoTile is the only fixed-ratio photo box in src/", () => {
  // The structural half of #422, and the assertion the old three-site version of
  // this file could not make. A hand-written box is exactly how the copies
  // drifted, so a new one has to be a test failure, not a reviewer's eye.
  //
  // The home page's hero is deliberately excluded: `aspect-[21/9]`,
  // absolutely positioned, with a gradient overlay over it — a different
  // component that happens to also be a fixed-ratio box. It is named here so
  // that deleting the hero does not silently widen the exemption.
  const EXEMPT: Record<string, string> = {
    "src/app/page.tsx": "aspect-[21/9]",
  };

  const offenders: string[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (relative === TILE) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/aspect-\[[^\]]*\]/g)) {
      const box = match[0];
      const expected = EXEMPT[relative];
      if (expected === box) continue;
      offenders.push(`${relative}: ${box}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these declare a fixed-ratio box of their own; use <PhotoTile> instead: ${offenders.join(", ")}`,
  );
});

test("the tile wrapper draws no frame with padding", () => {
  // #409, unchanged, on the file that now owns the box. Padding here is the only
  // thing that can produce this class of bug, because the image covers the
  // content box exactly. A dark background on its own is fine — it is the
  // letterbox backdrop behind a crop, and it stays hidden unless the image is
  // shorter than the box.
  const value = Object.values(tileWrapper(sourceOf(TILE))).join(" ");
  assert.doesNotMatch(
    value,
    /\bp-\d|\bpx-\d|\bpy-\d|\bpt-\d|\bpb-\d|\bpl-\d|\bpr-\d/,
    `PhotoTile pads its wrapper, which draws a frame around the image: ${value}`,
  );
});

test("the film backdrop is a letterbox, not a frame", () => {
  // What is left of the film special case after #409: a dark background that
  // shows only where `object-cover` crops. It was on the home and story tiles
  // since the first commit (30992dd) and never on the card, which is what made
  // the card's copy of the tile look arbitrary rather than conventional. With
  // #422 it is the tile's own decision, so it is asserted in one place.
  //
  // Asserted on the decision (`film`) and not on the inline conditional, because
  // the tile now hoists it to a named local: the same predicate has to choose the
  // backdrop *and* the fallback text colour, and two spellings of it would be two
  // chances to pair a dark backdrop with dark text.
  const source = sourceOf(TILE);
  assert.match(
    source,
    /const film = photo !== undefined && isFilmPhoto\(photo\)/,
    "the tile should derive one `film` predicate from the photo",
  );
  assert.match(
    source,
    /film \? "bg-stone-900" : "bg-gallery-200"/,
    "the tile's backdrop should follow that predicate",
  );
});

test("the film look still reaches the image", () => {
  // #409 removed a frame, not the film treatment. The colour filter is applied
  // to the image, so it cannot paint an edge — and if it were dropped, every
  // film photo would render unfiltered with no test failing.
  const source = sourceOf(TILE);
  assert.match(source, /filmLookClass\(photo\.filmLook\)/);
  assert.match(source, /\$\{filmLookClass\(photo\.filmLook\)\}/);
});

test("the three former call sites all use the tile", () => {
  // A structural change is only worth making if the call sites actually moved.
  // Without this, deleting the tile body and leaving three files importing it
  // would still pass everything above.
  for (const [file, count] of [
    ["src/components/PhotoCard.tsx", 1],
    ["src/app/page.tsx", 1],
    ["src/app/story/page.tsx", 1],
  ] as const) {
    const source = sourceOf(file);
    assert.match(source, /import \{ PhotoTile \} from "@\/components\/PhotoTile"/, `${file} should import PhotoTile`);
    const uses = source.match(/<PhotoTile\b/g) ?? [];
    assert.equal(uses.length, count, `${file} should render ${count} <PhotoTile>`);
  }
});

/**
 * The compiled stylesheet, built by the same PostCSS plugin `next build` uses,
 * with source detection narrowed to `src/`.
 *
 * Two things about this are load-bearing, and the second one was a bug found
 * while writing it.
 *
 * The point of compiling rather than reading source is that source cannot answer
 * the question. `aspect-[${ratio}]` is a perfectly reasonable-looking string
 * that Tailwind will not see, so an assertion like "the className contains an
 * aspect ratio" passes over a class that emits nothing. Only the built CSS
 * knows.
 *
 * The narrowing is `source(none)` plus an explicit `@source "../"`. Tailwind's
 * default scan runs from the stylesheet's directory up to the repo root and
 * skips only gitignored paths, and `tests/` is committed — so the strings in
 * *this file* were being fed to the scanner. With `aspect-[4/3]` deleted from
 * `PhotoTile`, the rule for it was still in the built CSS, because the assertion
 * below had written the class name out. The test passed because of its own
 * text, which is the precise failure this file exists to prevent.
 */
let stylesheet: Promise<string> | undefined;
function compiledCss(): Promise<string> {
  stylesheet ??= (async () => {
    const from = path.join(ROOT, "src/app/globals.css");
    const css = `${readFileSync(from, "utf8")}\n@source "../";\n`.replace(
      '@import "tailwindcss";',
      '@import "tailwindcss" source(none);',
    );
    const result = await postcss([tailwindcss()]).process(css, { from });
    return result.css;
  })();
  return stylesheet;
}

/**
 * The selector Tailwind writes for a class: `\[`, `\]`, `\/` and `\:` are
 * escaped in the stylesheet, so this is the literal text to search for — not a
 * pattern to match against.
 */
function selectorFor(className: string): string {
  return `.${className.replace(/[.*+?^${}()|[\]\\/:]/g, "\\$&")}`;
}

/** Whether the CSS declares a rule for exactly this class and not a longer one. */
function hasRule(css: string, className: string): boolean {
  const at = css.indexOf(selectorFor(className));
  if (at < 0) return false;
  // `aspect-[4/3]` must not be satisfied by `aspect-[4/3]` in a longer class, and
  // `group` must not be satisfied by `group-hover`.
  return !/[\w-]/.test(css[at + selectorFor(className).length] ?? " ");
}

test("every class the tile can emit survives the Tailwind scanner", async () => {
  const css = await compiledCss();

  for (const cls of [
    // The ratio map. Both must be present even though each call site passes only
    // one, because the map is what the scanner reads.
    "aspect-[4/3]",
    "aspect-[3/2]",
    // The duration map, same reasoning.
    "duration-500",
    "duration-700",
    // The rest of the tile's own className, which is interpolated too.
    "overflow-hidden",
    "rounded-sm",
    "object-cover",
    "group-hover:scale-105",
    "transition-transform",
    "bg-stone-900",
    "bg-gallery-200",
    // `group` itself is deliberately absent from this list: it declares nothing,
    // so Tailwind emits no rule for it and instead reaches it through
    // `:where(.group)` inside the `group-hover:` rule above. If that rule
    // disappears, the tile's hover stops working and this list catches it.
  ]) {
    // `assert.ok` rather than `assert.match`: a failing `match` prints the whole
    // 42KB stylesheet into the failure output, which is unreadable and hides the
    // message that says what to do about it.
    assert.ok(
      hasRule(css, cls),
      `PhotoTile can emit \`${cls}\`, but the built stylesheet has no rule for it. ` +
        `A Tailwind utility built in a template literal is invisible to the scanner.`,
    );
  }
});

test("no tile utility is built by interpolation", () => {
  // The negative control for the test above, and the one that makes it credible.
  // The bug was `aspect-[${ratio}]`: a plausible-looking template that Tailwind
  // never sees. The invariant is narrow enough to state exactly — a hyphen
  // immediately before an interpolation is a utility name whose tail exists
  // only at runtime, and the scanner cannot emit a class it cannot read.
  //
  // Not a general "no dynamic classes" check. This repo legitimately interpolates
  // whole alternatives (`${isFilmPhoto(photo) ? "bg-stone-900" :
  // "bg-gallery-200"}`) where the class is chosen rather than spelled. The
  // distinction is whether the class exists before or after the interpolation.
  //
  // Read from the AST, not the text, because this component's own comment quotes
  // both anti-patterns. A regex over source would fail on the documentation of
  // the bug, which is the wrong way round.
  const source = ts.createSourceFile(
    TILE,
    sourceOf(TILE),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) && node.name.text === "className" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isTemplateExpression(node.initializer.expression)
    ) {
      const template = node.initializer.expression;
      // `head` first, then every span's trailing text. Both are needed: for
      // `className={`group aspect-[${ratio}] …`}` the text before the *first*
      // substitution is the template's head, not any span's literal — checking
      // only the spans misses the first substitution in every template, which is
      // how this check passed the bug it was written for.
      const beforeSubstitutions = [template.head.text, ...template.templateSpans.map((s) => s.literal.text)];
      for (const before of beforeSubstitutions) {
        // A class built across the boundary is one whose name is still being
        // written when the substitution starts. Class names contain no spaces, so
        // text ending in `-` (a value or modifier separator, as in `duration-`)
        // or `[` (an arbitrary-value opener, as in `aspect-[`) is unambiguously
        // mid-name. Text ending in a letter is a complete name.
        const trimmed = before.replace(/\s+$/, "");
        const partial = /[-[]$/.exec(trimmed);
        if (partial) offenders.push(`${trimmed}\${…}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.deepEqual(
    offenders,
    [],
    `PhotoTile builds these utility names by interpolation, so Tailwind emits no rule for them: ${offenders.join(", ")}`,
  );
});
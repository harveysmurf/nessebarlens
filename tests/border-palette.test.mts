/**
 * #424 — the boundary between the surface ramp and the ink ramp.
 *
 * The site had two palettes and used them interchangeably. `globals.css` declares
 * the warm `gallery-*` ramp; everything else is Tailwind's neutral `stone-*`, and
 * a className could name either without the other minding. Seven borders and two
 * image backdrops did exactly that.
 *
 * The worst of them was one pixel tall: `SiteFooter` was `bg-gallery-50
 * border-t border-stone-200`, a warm panel closed by a cool grey line, while
 * `SiteHeader` two components away was `border-b border-gallery-200/70` on the
 * same colour. The header and the footer frame the same column of content, and
 * they were different colours, and nothing in the build could see it — the two
 * spellings were identical strings of the same length in files that never appear
 * in the same test.
 *
 * `gallery-200` (`#e6dfd5`) and `stone-200` (`#e7e5e4`) differ by 15/255 on blue.
 * On a body of text that is imperceptible; on a hairline it is a material change.
 * That is why the split is *by role* and not by hue: `gallery-*` is for surfaces
 * and the borders that separate them, `stone-*` is for ink — text, and the
 * borders that mark a state instead of separating anything.
 *
 * So there are two assertions here, and the second is the one that generalises.
 *
 * - **No `border-stone-200`.** The token is retired. A zero-occurrence assertion
 *   on a retired string is exact: it is not a count that a new site breaks loudly
 *   and a rename breaks silently, because there is nothing to rename it to.
 * - **Every remaining `border-stone-*` is a declared state border.** That is the
 *   check that catches the next one. A 15th border is not compared against a
 *   count — it is looked up in `INK_BORDERS`, and if it is not there it fails by
 *   name. Each entry carries the reason it is ink, so "why is this one still
 *   stone" is answerable from the test rather than from the diff.
 *
 * Deliberately **not** here: a contrast ratio. Architect's instruction on this
 * change was to keep borders out of the text audit — they are not text, and
 * growing #423's machinery into a 4.5:1 border rule would fail every hairline in
 * the site for a requirement that does not apply to them. What a hairline needs
 * is to belong to its surface, and that is a cohesion question, not a luminance
 * one. `muted-text-contrast.test.mts` still audits every `text-stone-*` at 4.5:1
 * and is untouched by this file.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const ROOT = path.resolve(import.meta.dirname, "..");

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
 * Every string literal and every template span in the file, grouped by whatever
 * enclosing `className` attribute contains them — or by the file, when there is
 * none.
 *
 * The grouping matters for the mixed-surface rule and only for that rule: it is
 * about *one element*, so whether the fill and the border on the same `className`
 * come from the same ramp. Flattened, `bg-gallery-50` from the footer and a
 * `border-stone-900` from a radio button somewhere else would read as one
 * element wearing two palettes.
 *
 * AST rather than regex, for the reason `muted-text-contrast.test.mts` gives:
 * this change adds comments quoting the old strings, and a regex over source
 * reads its own documentation as a violation.
 *
 * A literal that is not inside a `className` still counts, as a group of its own.
 * That is not slack — it is the model Tailwind itself uses. Tailwind reads the
 * *text* of a source file, not its JSX, so a border written into a module
 * constant and handed to `className` later ships a rule exactly as one written
 * inline does. Scanning only attributes would make `INK_BORDERS`'s entry for
 * `field-styles.ts` unreachable: `CONTROL_HEAD` is a module constant, no
 * attribute ever contains it, and the entry would be asserting coverage of a
 * string the test cannot see.
 */
function classGroups(source: ts.SourceFile): string[][] {
  const groups: string[][] = [];
  const collect = (node: ts.Node): string[] => {
    const tokens: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        tokens.push(n.text);
        return;
      }
      // A template's head and middle are their own node kinds, so their text has
      // to be taken explicitly or every interpolated class is missed.
      if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        tokens.push(n.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return tokens;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "className" &&
      node.initializer
    ) {
      groups.push(collect(node.initializer));
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      groups.push([node.text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return groups;
}

/** The only `className` attribute groups — for the rules that are per element. */
function classNameAttributes(source: ts.SourceFile): string[][] {
  const attributes: string[][] = [];
  const collect = (node: ts.Node): string[] => {
    const tokens: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        tokens.push(n.text);
        return;
      }
      if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        tokens.push(n.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return tokens;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "className" &&
      node.initializer
    ) {
      attributes.push(collect(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return attributes;
}

/** Every `(file, token)` spelling a class, from the whole tree. */
function classUses(): { file: string; token: string }[] {
  const uses: { file: string; token: string }[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relative,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const group of classGroups(source)) {
      for (const token of group) uses.push({ file: relative, token });
    }
  }
  return uses;
}

/**
 * Every `border-stone-*` that survives, with the reason it is ink.
 *
 * The list is the design, stated where it can be checked. A border belongs here
 * only if it marks a *state* — this control is selected, this one is hovered,
 * this link is underlined as a link. A border that merely separates one panel
 * from another is a surface border and belongs on the `gallery` ramp.
 *
 * The two that need the argument written down rather than assumed are the two
 * `stone-300`s, and the argument is the same one in both: **the surface ramp has
 * no step at that lightness.** `gallery` ships 50, 100, 200 and 900, so the
 * nearest warm candidate to `stone-300` (`#d6d3d1`, 1.47:1 on white) is
 * `gallery-200` (`#e6dfd5`, 1.19:1 on white) — visibly heavier, and a new step
 * would be an invention rather than a conversion. Both sites are also chrome
 * that is not a brand surface: a form input's own boundary, and the frame of the
 * preview viewport. Neither separates two brand panels, which is what the
 * `gallery` ramp is for.
 *
* The preview frame is the one Architect's instruction called out in advance — "if
 * one sits on non-brand chrome, name it and keep it stone" — and it was measured
 * rather than assumed. The frame sits inside the white purchase card, so there
 * are two nested edges and both have to stay legible. At 60% over white
 * `border-gallery-200` composites to `(240, 236, 230)` and measures **1.18:1**
 * against it, while the card's own edge (`gallery-200/80` on the page) measures
 * **1.19:1**. The inner and outer lines would land on the same value and the
 * card would stop reading as containing anything. Left as `stone-300` the frame
 * measures **1.26:1** — a step stronger than the edge around it, which is what
 * says "nearer". So it stays stone, by arithmetic rather than by taste.
 *
 * Everything that does separate brand surfaces moved, including the two that are
 * easy to forget because they were never `stone-200`: the photo tile's non-film
 * backdrop (`bg-stone-200` → `bg-gallery-200`, asserted in `gallery-tiles`) and
 * the price block's hairline inside the white purchase card (`border-y
 * stone-100` → `gallery-100`, which exists and is within 6/255 of `stone-100`
 * on every channel — the same weight, not a seam).
 */
const INK_BORDERS: Record<string, string> = {
  "src/components/SiteHeader.tsx: border-stone-900":
    "the current nav page's 2px underline — a state, not a separator",
  "src/components/PrintConfigurator.tsx: border-stone-900":
    "the selected print format's 2px ring — a state",
  "src/components/PrintPreview.tsx: border-stone-900":
    "the selected preview view's 1px ring — a state",
  "src/components/PrintConfigurator.tsx: hover:border-stone-400":
    "hover on an unselected format. Its resting border is the surface ramp, so this one className carries both ramps on purpose: idle is a separator, hovered is a state",
  "src/app/[locale]/checkout/success/page.tsx: border-stone-800":
    "the underline of a link, not a divider between panels",
  "src/components/PrintPreview.tsx: border-stone-300":
    "the preview viewport's own frame — non-brand chrome, and the only stone border with a second edge to be measured against. As `gallery-200/60` it would measure 1.18:1 inside a card whose own edge is 1.19:1, so the two lines would collapse into one; as `stone-300/60` it measures 1.26:1 and reads as the nearer of the two",
  "src/components/field-styles.ts: border-stone-300":
    "a form control's own boundary. Control chrome, owned by #419's module; the ramp's lightest visible step is `gallery-200` at 1.19:1 on white against this one's 1.47:1, so there is no warm step at this weight to convert it to",
};

/**
 * `border-transparent` is not stone, so this rule cannot see it — and it should
 * not: the inactive nav link's transparent underline has to match the active
 * one's width, and a `gallery` version would draw a line under every nav item
 * that is not the current page. Named here so the asymmetry is on the record.
 */

test("the stone border token is retired", () => {
  // Exact, and the exactness is the point. There is no `border-stone-200` left to
  // confuse with a `gallery-200`, and `border-gallery-200` is a different string,
  // so a search for the retired one cannot be satisfied by the replacement.
  const stillThere = classUses()
    .filter(({ token }) => /\bborder-stone-200\b/.test(token))
    .map(({ file, token }) => `${file}: ${token}`);

  assert.deepEqual(
    stillThere,
    [],
    `border-stone-200 was retired in #424 — surfaces and separators are the\n` +
      `gallery ramp now. These still use it:\n  ${stillThere.join("\n  ")}`,
  );
});

test("every stone border left marks a state, and says which one", () => {
  // The general guard, and the one that catches the next border rather than the
  // seventh past one. A `border-stone-*` with no entry here is a separator that
  // ended up on the ink ramp — which is what the footer's was.
  const offenders: string[] = [];
  for (const { file, token } of classUses()) {
    // Only the ramp, not the border's width or side, and not `hover:`-prefixed
    // classes — those are looked up under their own key below.
    for (const match of token.matchAll(/(?:[\w:/.[\]-]+:)?border-(stone-\d+)/g)) {
      // The key is the file and the colour step, with any variant prefix kept:
      // `hover:border-stone-400` and `border-stone-400` are different decisions
      // and get different answers. Widths and sides (`border-2`, `border-y`) are
      // dropped — they are not what makes a border ink or surface.
      const spelled = match[0];
      const key = `${file}: ${spelled}`;
      if (!INK_BORDERS[key]) offenders.push(key);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these stone borders are not declared in INK_BORDERS:\n  ${offenders.join("\n  ")}\n` +
      `Either they separate surfaces, in which case they are \`border-gallery-200\`,\n` +
      `or they mark a state, in which case add them with the reason.`,
  );
});

test("a warm surface is never closed by a cool border", () => {
  // The footer bug stated as a rule, so the next mixed pair fails even if it
  // picks a step this file has never seen — `border-stone-300` on `bg-gallery-50`
  // would pass the two tests above if someone added it to `INK_BORDERS` wrongly,
  // and would fail here whatever the list says.
  const mixed: string[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relative,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const tokens of classNameAttributes(source)) {
      const joined = tokens.join(" ");
      const fills = [...joined.matchAll(/\bbg-(gallery|stone)-\d+\b/g)].map((m) => m[0]);
      const borders = [...joined.matchAll(/(?:[\w-]+:)?border-(gallery|stone)-\d+\b/g)].map(
        (m) => m[0],
      );
      if (fills.length === 0 || borders.length === 0) continue;
      // Only an explicit fill can be mixed: a `className` that sets a border but
      // inherits its fill is not making a claim about the surface.
      const surface = fills.find((f) => f.startsWith("bg-gallery-"));
      if (!surface) continue;
      const cool = borders.filter((b) => b.includes("stone-") && !b.includes("border-transparent"));
      if (cool.length > 0) mixed.push(`${relative}: ${surface} with ${cool.join(", ")}`);
    }
  }

  assert.deepEqual(
    mixed,
    [],
    `a gallery surface closed by a stone border:\n  ${mixed.join("\n  ")}`,
  );
});

test("the white cards are the only non-gallery surfaces, and they are declared", () => {
  // `bg-white` is a surface on neither ramp. It is legitimate — a purchase card
  // should read as paper — but it is a third material, so it is counted rather
  // than assumed, and the count is the thing that changes if someone adds a
  // fourth one.
  const cards: string[] = [];
  for (const { file, token } of classUses()) {
    if (/\bbg-white\b/.test(token)) cards.push(file);
  }
  assert.deepEqual(
    [...new Set(cards)].sort(),
    ["src/app/[locale]/checkout/success/page.tsx", "src/components/PrintDetail.tsx"],
    `the white surfaces have moved: ${[...new Set(cards)].join(", ")}`,
  );
});

test("every declared gallery token is used, and every used one is declared", () => {
  // `--gallery-800` was deleted in #424: declared, published to the theme, and
  // used zero times in `src/`. That is not harmless bookkeeping. It is a fifth
  // step in a contrast table that a reader counts as real, and the sixth-table
  // problem from #421 in a different costume.
  //
  // So the ramp is closed in both directions. A declared step nothing reaches
  // fails, which is what would have caught `gallery-800` before this change; and a
  // used step nothing declares fails too, which catches a typo in a ramp that has
  // no `bg-*` class to compile-fail against.
  const css = sourceOf("src/app/globals.css");
  const declared = new Set(
    [...css.matchAll(/--color-gallery-(\d+):/g)].map((m) => `gallery-${m[1]}`),
  );
  assert.ok(declared.size > 0, "globals.css should declare the gallery ramp");

  const used = new Set<string>();
  for (const { token } of classUses()) {
    for (const match of token.matchAll(/(?:^|[\s:/])((?:bg|text|border|from|to|via|via)-gallery-\d+)/g)) {
      used.add(match[1].slice(match[1].indexOf("gallery-")));
    }
  }

  assert.deepEqual(
    [...declared].filter((step) => !used.has(step)),
    [],
    `declared in the theme but used nowhere in src/: ${[...declared]
      .filter((s) => !used.has(s))
      .join(", ")}. Delete it, or use it.`,
  );
  assert.deepEqual(
    [...used].filter((step) => !declared.has(step)),
    [],
    `used in src/ but not declared in globals.css: ${[...used]
      .filter((s) => !declared.has(s))
      .join(", ")}. It will compile to nothing and render as no colour at all.`,
  );

  // And `gallery-800` specifically, so the deletion cannot be quietly undone by a
  // merge that restores the old `:root` block wholesale.
  // The colon is what makes this a declaration rather than prose: the comment
  // above `:root` explains why the step was deleted, and names it.
  assert.doesNotMatch(
    css,
    /--gallery-800\s*:/,
    "--gallery-800 was deleted in #424 as an unused step; it has no uses in src/",
  );
});
/**
 * What the `@source not` lines in `globals.css` are for.
 *
 * Tailwind's default source detection reads the whole project, so anything that
 * merely *names* a utility gets a rule for it. This repo keeps the test suite in
 * `tests/` — where class names are quoted in assertions and explained in
 * comments — and a 129KB design document at the repository root that uses them
 * as English words. Neither is a page. Before these exclusions the shipped
 * stylesheet carried rules for the retired border step, the step its hover
 * variant uses, `collapse`, `invert`, `p-2` and one class made out of an
 * ordinary verb.
 *
 * `AGENTS.md` joins them for a sharper reason: it is the file that records this
 * invariant for the next agent, and `next dev` rewrites it, so it is where a
 * utility name would most plausibly accumulate by accident.
 *
 * The exclusion itself is asserted as text rather than measured through a build.
 * That is a deliberate retreat, and the reason is worth recording: compiling
 * `globals.css` with Tailwind's default detection does reproduce the effect, but
 * the result depends on Tailwind's scan cache, and the cache is keyed on the
 * file's content. Building straight after an edit to `globals.css` returned a
 * stale candidate set — a mutation that added a retired utility to the file's
 * comments passed the measurement. A guard that can pass when it should fail is
 * worse than no guard, so this asserts the lines are present and the *source*
 * compiles clean, both of which are exact.
 */
const EXCLUDED_FROM_PRODUCTION_CSS = [
  "../../tests",
  "../../scripts",
  "../../DEVELOPMENT.md",
  "../../AGENTS.md",
];

test("the paths that are not source cannot reach the production stylesheet", () => {
  const css = sourceOf("src/app/globals.css");

  // Each one named, rather than a count: an unscanned path is the failure this is
  // for, and "three are excluded" would not say which one is missing.
  const missing = EXCLUDED_FROM_PRODUCTION_CSS.filter(
    (dir) => !new RegExp(`@source not "${dir.replace(/[./]/g, (c) => `\\${c}`)}";`).test(css),
  );
  assert.deepEqual(
    missing,
    [],
    `these are scanned by Tailwind but are not pages:\n  ${missing.join("\n  ")}\n` +
      `A class name mentioned in a test assertion or a design document becomes a\n` +
      `live rule in production CSS. Add \`@source not\` for it.`,
  );
});

test("the retired border step compiles to no rule at all", async () => {
  // Not the default-detection build — the `src/`-only one, `source(none)` plus an
  // explicit `@source`, which is the pattern `gallery-tiles.test.mts` established
  // in #422 and which does not depend on what the developer's scan cache holds.
  // What it proves is the half that matters: nothing in `src/` — code or comment
  // — asks for the colour this change retired.
  const from = path.join(ROOT, "src/app/globals.css");
  const built = (
    await postcss([tailwindcss()]).process(
      `${sourceOf("src/app/globals.css")}\n@source "../";\n`.replace(
        '@import "tailwindcss";',
        '@import "tailwindcss" source(none);',
      ),
      { from },
    )
  ).css;

  const hasRule = (className: string): boolean => {
    const selector = `.${className}`;
    const at = built.indexOf(selector);
    return at >= 0 && !/[\w-]/.test(built[at + selector.length] ?? " ");
  };

  assert.ok(
    !hasRule("border-stone-200"),
    "the border step retired in #424 still compiles to a rule. Its only remaining\n" +
      "names are in prose, and Tailwind reads file text.",
  );
  // The positive control. A stylesheet with nothing in it would satisfy the
  // assertion above, so the replacement is checked in the same breath.
  assert.ok(
    hasRule("border-gallery-200"),
    "border-gallery-200 is used in src/ and must compile to a rule — if it does\n" +
      "not, the build above is not compiling this project's sources.",
  );
});

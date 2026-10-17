/**
 * #424 — the two type tokens, and why there are two.
 *
 * The eyebrow — a tiny uppercase tracked label above a heading — was spelled four
 * ways across twelve files, and the split ran through the middle of
 * `tracking-widest`, which held both the page's eyebrows and its button labels.
 * The obvious consolidation — one token for "the small uppercase tracked thing" —
 * is what this file exists to refuse.
 *
 * The two are not the same thing. A button label is `text-white` on `bg-stone-900`,
 * 17.49:1, and its contrast is decided entirely by the button it lands on. A page
 * eyebrow is `text-stone-500` on `--gallery-50`, 4.53:1, and that is the value
 * #423 spent an issue moving — with 0.03 to spare. Under one token, the second
 * gets audited against the first's surface: the eyebrow inherits the button's
 * comfortable margin, or the button label is checked against `#faf8f5` instead of
 * its own fill. That is the same shape as the bug #423 just fixed, where a
 * light-on-dark hero caption was audited as light-on-light and reported as a 1.41:1
 * failure. So the two are declared apart and each is held to its own surface.
 *
 * Four things are pinned, each in the way it can break:
 *
 * - **the rendered string is unchanged.** Both tokens are compared against the
 *   exact literals they replaced, byte for byte. This is a refactor; if a token
 *   changes what renders, that is a different pull request with a screenshot in it.
 * - **a `BUTTON_LABEL` on the wrong surface fails.** Not a count of sites — a
 *   lookup: every use must carry `bg-stone-900` in the same `className`. Drop the
 *   fill and the token's contrast contract quietly stops applying.
 * - **the tracking cannot be re-spelled.** Six sites wrote `tracking-[0.3em]` out
 *   and eight wrote `tracking-widest`, which is 0.1em — a third of the letter
 *   spacing, which at 10px is the difference between a label and a word. The
 *   literal now lives in one module and nowhere else.
 * - **the utilities survive the scanner.** A Tailwind utility assembled inside a
 *   module is invisible to the scanner unless every candidate is a literal, which
 *   is how `aspect-[${ratio}]` shipped without a rule. Both tokens are written as
 *   literal candidates, and the compiled stylesheet is checked for each.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

import { BUTTON_LABEL, eyebrowClass } from "../src/components/type-styles.ts";
import { contrast, oklchToHex } from "./contrast.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** WCAG 2.2 AA for normal text. `text-xs` and `text-[10px]` are both normal. */
const AA_NORMAL_TEXT = 4.5;

/** The literals these two tokens replaced, byte for byte. See the header. */
const EYEBROW_LITERAL = "text-[10px] uppercase tracking-[0.3em] text-stone-500 font-medium";
const BUTTON_LABEL_LITERAL = "text-xs uppercase tracking-widest font-medium";

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
 * Every `className` initializer in the tree, with its file, as source text.
 *
 * `text` is the whole initializer rather than the string literals inside it,
 * because what has to be checked here is a *reference* to a token — `${BUTTON_LABEL}`
 * inside a template, or `eyebrowClass()` as a bare call. A literal-only walk finds
 * neither, so `BUTTON_LABEL` could be used on a page background and this file
 * would see an empty className and pass.
 */
function classNameInitializers(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relative,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "className" &&
        node.initializer
      ) {
        found.push({ file: relative, text: node.initializer.getText(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test("the eyebrow renders exactly the literal it replaced", () => {
  assert.equal(
    eyebrowClass(),
    EYEBROW_LITERAL,
    "the default eyebrow must render the string the six sites used to spell",
  );
  // The two variants differ from the default in one axis each, which is what
  // makes them the same thing at a different setting rather than a second thing.
  assert.equal(
    eyebrowClass("accent").replace("text-amber-200", "text-stone-500"),
    EYEBROW_LITERAL,
    "accent is the amber category eyebrow: same size, same tracking, one colour swapped",
  );
  assert.equal(
    eyebrowClass("signature").replace("text-[9px]", "text-[10px]"),
    EYEBROW_LITERAL,
    "the header tagline is the same eyebrow one step smaller, not a different label",
  );
});

test("the button label renders exactly the typography it replaced", () => {
  assert.equal(BUTTON_LABEL, BUTTON_LABEL_LITERAL);
});

test("the two tokens are not the same thing", () => {
  // 0.1em against 0.3em. Not a rounding difference: at `text-[10px]` it is 1px of
  // letter spacing against 3px, and at `text-xs` 1.2px against 3.6px. Collapsing
  // them would change every button on the site to look like a section heading.
  assert.ok(
    eyebrowClass().includes("tracking-[0.3em]") && !eyebrowClass().includes("tracking-widest"),
    "the eyebrow keeps the wider 0.3em tracking",
  );
  assert.ok(BUTTON_LABEL.includes("tracking-widest"), "the button label keeps 0.1em");
});

/** A Tailwind colour as the hex it ships, from where it is declared. */
function tailwindHex(name: string): string {
  const oklch = sourceOf("node_modules/tailwindcss/theme.css").match(
    new RegExp(`--color-${name}:\\s*oklch\\(([^)]+)\\)`),
  );
  assert.ok(oklch, `Tailwind should publish a ${name} colour`);
  const [l, c, h] = oklch[1].split(/\s+/);
  return oklchToHex(
    // Tailwind writes lightness as a percentage; oklch() takes 0–1, and reading
    // "55.3%" as 55.3 clamps every channel to white.
    Number.parseFloat(l) / (l.endsWith("%") ? 100 : 1),
    Number.parseFloat(c),
    Number.parseFloat(h),
  );
}

test("each token's foreground clears AA on its own surface", () => {
  // The point of two tokens: two surfaces, two ratios, both computed from the
  // declaration rather than written as a number, so a background move re-breaks
  // this instead of passing it. The eyebrow's is the 4.53:1 of #423 — 0.03 to
  // spare, which is exactly why it has to be recomputed.
  const css = sourceOf("src/app/globals.css");
  const page = css.match(/--gallery-50:\s*(#[0-9a-f]{6})/i);
  assert.ok(page, "--gallery-50 should be declared as a hex in globals.css");

  const muted = tailwindHex("stone-500");
  const fill = tailwindHex("stone-900");

  const eyebrow = contrast(muted, page[1]);
  const button = contrast("#ffffff", fill);
  assert.ok(
    eyebrow >= AA_NORMAL_TEXT,
    `the eyebrow's text-stone-500 (${muted}) is ${eyebrow.toFixed(2)}:1 on the page ` +
      `background ${page[1]}; #423 moved 33 sites to this step for exactly this`,
  );
  assert.ok(
    button >= AA_NORMAL_TEXT,
    `the button label's text-white is ${button.toFixed(2)}:1 on ${fill}`,
  );

  // Both margins in the output, because the whole argument for keeping these
  // apart is that they are not the same number.
  console.log(
    `type tokens — eyebrow ${muted} at ${eyebrow.toFixed(2)}:1 on the page, ` +
      `button label #ffffff at ${button.toFixed(2)}:1 on ${fill}`,
  );
});

test("every BUTTON_LABEL sits on the fill its contrast is computed against", () => {
  // The contract, enforced at the call site rather than described in a comment.
  // A `BUTTON_LABEL` on the page background is still a legible label, so nothing
  // else in the build would notice — it would just stop being the token whose
  // 17.49:1 was ever checked.
  const wrong: string[] = [];
  let uses = 0;
  for (const { file, text } of classNameInitializers()) {
    if (!text.includes("BUTTON_LABEL")) continue;
    uses += 1;
    if (!/\bbg-stone-900\b/.test(text)) wrong.push(`${file}: ${text}`);
  }
  assert.ok(uses > 0, "BUTTON_LABEL should be used somewhere, or the token is dead");
  assert.deepEqual(
    wrong,
    [],
    `BUTTON_LABEL is white-on-stone-900; without that fill it is a page-surface\n` +
      `label carrying a contrast value that was never checked against it:\n  ${wrong.join("\n  ")}`,
  );
});

test("no call site spells the eyebrow's tracking any more", () => {
  // Six sites wrote `tracking-[0.3em]` and eight wrote `tracking-widest`. Only the
  // module may now, or the next eyebrow picks whichever it finds first.
  const spelled: string[] = [];
  for (const { file, text } of classNameInitializers()) {
    if (file === "src/components/type-styles.ts") continue;
    if (/tracking-\[0\.3em\]/.test(text)) spelled.push(`${file}: ${text}`);
  }
  assert.deepEqual(
    spelled,
    [],
    `the eyebrow is eyebrowClass() now:\n  ${spelled.join("\n  ")}`,
  );
});

test("both tokens are in use, so neither is dead", () => {
  const initializers = classNameInitializers();
  assert.ok(
    initializers.some(({ text }) => text.includes("eyebrowClass")),
    "eyebrowClass should be used by at least one page",
  );
  // A third check on the same theme as the deleted --gallery-800: a token nobody
  // reaches is a claim about the site's type that nothing backs up.
});

test("every utility the tokens can emit survives the Tailwind scanner", async () => {
  // `source(none)` plus an explicit `@source` matters here and is not incidental:
  // with Tailwind's default scan, this file's own source keeps a rule alive after
  // the class is deleted from the module — the failure #422 hit. Scanning only
  // `src/` means the tokens' literals are the sole reason those rules exist.
  const from = path.join(ROOT, "src/app/globals.css");
  const css = `${readFileSync(from, "utf8")}\n@source "../";\n`.replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  const built = (await postcss([tailwindcss()]).process(css, { from })).css;

  const candidates = new Set<string>([
    ...eyebrowClass("muted").split(" "),
    ...eyebrowClass("accent").split(" "),
    ...eyebrowClass("signature").split(" "),
    ...BUTTON_LABEL.split(" "),
  ]);

  for (const cls of candidates) {
    const selector = `.${cls.replace(/[.*+?^${}()|[\]\\/:]/g, "\\$&")}`;
    const at = built.indexOf(selector);
    // `assert.ok` rather than `assert.match`: a failing match prints the whole
    // stylesheet, which buries the sentence saying what to do about it.
    assert.ok(
      at >= 0 && !/[\w-]/.test(built[at + selector.length] ?? " "),
      `type-styles can emit \`${cls}\`, but the built stylesheet has no rule for it. ` +
        `A utility assembled inside a module is invisible to the scanner.`,
    );
  }
});
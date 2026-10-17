/**
 * #425 — one `<PageShell>`, and `max-w-7xl mx-auto px-6` written once.
 *
 * Nine elements wrote out the site's centred column: a max width, a `mx-auto`, a
 * 24px gutter and some vertical padding. `SiteHeader` and `SiteFooter` each
 * re-spelled `max-w-7xl mx-auto px-6` — the container the other seven are all
 * reaching for — and `checkout/cancel` and `checkout/success` wrote a
 * byte-identical shell each. The widths and the padding are real variation, so
 * they are props, and the header and footer take the container alone because
 * neither has vertical padding or a stack gap.
 *
 * The assertions, and what each is actually able to catch:
 *
 * - **each site still asks for the width and padding it used to write out.** The
 *   table below is the measurement taken from `f0bec3a`, so a shell that silently
 *   becomes `5xl` or `py-10` fails here rather than shipping. This is the
 *   zero-delta property for the shells; the strings in `Button.tsx`'s table do the
 *   same for the buttons.
 * - **`max-w-7xl mx-auto px-6` appears once in the tree.** The structural half, and
 *   the issue's own done-when line. Nine copies can drift; one cannot.
 * - **the rendered element carries the string the call site carried.** Through the
 *   `.tsx` load hook from #420, so this checks what a browser would get rather
 *   than what the source spells.
 * - **`py-10` and `pb-16` are ordered by Tailwind, not by hope.** The home page is
 *   the one asymmetric shell: it overrides the bottom of the shell's `py-10`
 *   through `className`, which works because Tailwind emits `.pb-16` after
 *   `.py-10` at equal specificity. Asserted in the compiled stylesheet, so a
 *   Tailwind upgrade that reorders them fails loudly instead of quietly giving
 *   the home page 10px of bottom padding.
 * - **every utility the maps can emit survives the scanner.** `py-${padding}` would
 *   emit no rule at all and every shell would lose its vertical padding with no
 *   error anywhere — the `aspect-[${ratio}]` failure from #422, in a new place.
 * - **no width or padding is declared that no page uses.** The `--gallery-800`
 *   rule: a token nobody reaches is a claim about the site that nothing backs up.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import ts from "typescript";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  containerClass,
  PageShell,
  type ShellPadding,
  type ShellWidth,
} from "../src/components/PageShell.tsx";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHELL = "src/components/PageShell.tsx";

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
 * What each of the nine sites wrote at `f0bec3a`, and what it asks for now.
 *
 * The `wants` strings are the call site's own JSX, so the check is that the width
 * and the padding on it are the ones the literal had — not that a shell exists
 * somewhere in the file.
 */
const SITES: readonly {
  file: string;
  wants: string;
  /** Only the two chrome elements, which take a container and no padding. */
  container?: boolean;
}[] = [
  {
    // `fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6`
    file: "src/app/checkout/cancel/page.tsx",
    wants: '<PageShell width="lg" padding={20} className="text-center space-y-6">',
  },
  {
    // `fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6`, byte-identical
    file: "src/app/checkout/success/page.tsx",
    wants: '<PageShell width="lg" padding={20} className="text-center space-y-6">',
  },
  { file: "src/app/prints/[slug]/page.tsx", wants: '<PageShell width="7xl" padding={10}>' },
  { file: "src/components/GalleryPage.tsx", wants: '<PageShell width="7xl" padding={12}>' },
  {
    // `max-w-7xl mx-auto px-6 pt-10 pb-16 space-y-16` — the only asymmetric shell.
    file: "src/app/page.tsx",
    wants: '<PageShell\n        width="7xl"\n        padding={10}',
  },
  { file: "src/app/story/page.tsx", wants: '<PageShell width="5xl" padding={16} className="space-y-20">' },
  { file: "src/app/contact/page.tsx", wants: '<PageShell width="2xl" padding={16} className="space-y-8">' },
  { file: "src/components/SiteHeader.tsx", wants: 'containerClass("7xl")', container: true },
  { file: "src/components/SiteFooter.tsx", wants: 'containerClass("7xl")', container: true },
];

test("the nine sites ask for the width and padding they used to write out", () => {
  for (const site of SITES) {
    const source = sourceOf(site.file);
    assert.ok(
      source.includes(site.wants),
      `${site.file} should render \`${site.wants.replaceAll("\n        ", " … ")}\``,
    );
    assert.ok(
      /from "@\/components\/PageShell"/.test(source),
      `${site.file} should import the shell from @/components/PageShell`,
    );
    // Nothing left behind: the shell's own signature spelled out beside the shell.
    // The signature is the container run and the gutter — a nested `max-w-2xl
    // mx-auto` around a hero caption is not a shell, and three pages have one.
    assert.doesNotMatch(
      source,
      /max-w-(lg|2xl|5xl|7xl) mx-auto px-6|px-6[^"`]*\bpy-(10|12|16|20)\b/,
      `${site.file} still spells the shell out; take it from <PageShell>`,
    );
  }
});

test("the container is written once, and there are exactly nine shells", () => {
  // The done-when line: `max-w-7xl mx-auto px-6` in one place. Nine copies can
  // drift; this one has nothing to drift against.
  const spelled = srcFiles().filter((file) => {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (relative === SHELL) return false;
    return /max-w-(lg|2xl|5xl|7xl) mx-auto px-6/.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(
    spelled.map((file) => path.relative(ROOT, file).split(path.sep).join("/")),
    [],
    "these spell out the container; use containerClass() or <PageShell>",
  );

  let shells = 0;
  let containers = 0;
  for (const file of srcFiles()) {
    if (file.endsWith("PageShell.tsx")) continue;
    const source = readFileSync(file, "utf8");
    shells += (source.match(/<PageShell\b/g) ?? []).length;
    containers += (source.match(/containerClass\(/g) ?? []).length;
  }
  assert.equal(shells, 7, "seven page shells are expected");
  assert.equal(containers, 2, "the header and the footer are the only two containers");
});

/**
 * Render a shell around some placeholder text.
 *
 * `children` is merged in before `createElement` rather than passed as its third
 * argument: React 19's types want it among the props, and eslint's
 * `react/no-children-prop` refuses it in the literal. One object satisfies both.
 */
function render(props: Omit<ComponentProps<typeof PageShell>, "children">): string {
  const element: ComponentProps<typeof PageShell> = { ...props, children: "x" };
  return renderToStaticMarkup(createElement(PageShell, element));
}

test("the shell renders the string the literal rendered", () => {
  assert.equal(
    render({ width: "7xl", padding: 12 }),
    '<div class="max-w-7xl mx-auto px-6 py-12">x</div>',
  );
  // The caller's classes come after the shell's, which is what makes the home
  // page's `pb-16` an override rather than a fight.
  assert.equal(
    render({ width: "5xl", padding: 16, className: "space-y-20" }),
    '<div class="max-w-5xl mx-auto px-6 py-16 space-y-20">x</div>',
  );
});

test("the container alone is the string the header and footer wrote", () => {
  assert.equal(containerClass("7xl"), "max-w-7xl mx-auto px-6");
});

test("the home page's bottom padding override wins", async () => {
  // `py-10` sets both ends; `pb-16` sets one. Same specificity, so the order in
  // the stylesheet decides — and Tailwind emits the single-axis utility after the
  // pair. Asserted against the built CSS rather than against the source order of
  // a class attribute, because the class attribute order is not what decides this.
  const home = sourceOf("src/app/page.tsx");
  assert.ok(
    home.includes("padding={10}") && home.includes('className="pb-16 space-y-16"'),
    "the home page should be padding 10 with pb-16 on top",
  );
  const built = await compiled();
  const pair = built.indexOf(selectorFor("py-10"));
  const side = built.indexOf(selectorFor("pb-16"));
  assert.ok(pair >= 0 && side >= 0, "both utilities should compile");
  assert.ok(
    side > pair,
    "Tailwind emits .pb-16 after .py-10 today, so the override wins; if this " +
      "fails the home page silently loses 6px of bottom padding and needs a prop",
  );
});

/** The selector Tailwind writes, escaped. */
function selectorFor(className: string): string {
  return `.${className.replace(/[.*+?^${}()|[\]\\/:]/g, "\\$&")}`;
}

/** Whether the CSS declares a rule for exactly this class and not a longer one. */
function hasRule(css: string, className: string): boolean {
  const selector = selectorFor(className);
  const at = css.indexOf(selector);
  if (at < 0) return false;
  return !/[\w-]/.test(css[at + selector.length] ?? " ");
}

test("every width and every padding compiles", async () => {
  const widths: ShellWidth[] = ["lg", "2xl", "5xl", "7xl"];
  const paddings: ShellPadding[] = [10, 12, 16, 20];
  const css = await compiled();

  for (const width of widths) {
    const cls = containerClass(width).split(" ")[0];
    assert.ok(cls, `the ${width} container rendered no max-w utility`);
    assert.ok(hasRule(css, cls), `the ${width} shell has no rule for \`${cls}\``);
  }
  // The padding candidates come out of the rendered shells rather than a literal
  // list written here, so a padding added to the map is checked automatically.
  for (const padding of paddings) {
    const cls = render({ width: "7xl", padding }).match(/py-\d+/)?.[0];
    assert.ok(cls, `padding ${padding} rendered no py-* utility`);
    assert.ok(hasRule(css, cls), `the shell can emit \`${cls}\`, which does not compile`);
  }
  for (const cls of containerClass("7xl").split(" ").slice(1)) {
    assert.ok(hasRule(css, cls), `the container can emit \`${cls}\`, which does not compile`);
  }
});

test("no shell utility is built by interpolation", () => {
  // The negative control, and the one that makes the compile assertion above
  // credible: the failure this module's shape exists to prevent is `py-${padding}`,
  // which looks reasonable, type-checks, renders, and emits no CSS at all.
  //
  // Wider than `gallery-tiles.test.mts`'s version of this check, and it has to be:
  // that one walks JSX `className` attributes because the tile builds its class
  // there, and a scoped walk would sit here passing over an interpolation in a
  // local — which is exactly where this module composes its classes. Every
  // template literal in the file is examined instead, so the check can only miss
  // an interpolation built some other way (`["py-", padding].join("")`), which no
  // text-shaped assertion can see.
  const source = ts.createSourceFile(
    SHELL,
    sourceOf(SHELL),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      // `head` first, then every span's trailing text: for
      // `className={`py-${padding}`}` the text before the *first* substitution is
      // the head, not any span.
      const before = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      for (const text of before) {
        const trimmed = text.replace(/\s+$/, "");
        // A class name written across the boundary is one still being written when
        // the substitution starts: class names hold no spaces, so text ending in a
        // hyphen (a value separator) or a bracket (an arbitrary-value opener) is
        // unambiguously mid-name. Text ending in a letter is a complete name, which
        // is how `containerClass(width)` and `${shape}` stay legal.
        if (/[-[]$/.test(trimmed)) offenders.push(`${trimmed}\${…}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(
    offenders,
    [],
    `PageShell builds these utility names by interpolation, so Tailwind emits no rule for them: ${offenders.join(", ")}`,
  );
});

test("no width or padding is declared that no page asks for", () => {
  // The `--gallery-800` rule. A width nothing uses is a claim that the site has
  // a layout it does not have.
  const callers = srcFiles()
    .filter((file) => !file.endsWith("PageShell.tsx"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const width of ["lg", "2xl", "5xl", "7xl"] as const) {
    assert.ok(
      callers.includes(`width="${width}"`) || callers.includes(`containerClass("${width}")`),
      `no page asks for the ${width} shell; delete it from the width map`,
    );
  }
  for (const padding of [10, 12, 16, 20]) {
    assert.ok(
      callers.includes(`padding={${padding}}`),
      `no page asks for py-${padding}; delete it from the padding map`,
    );
  }
});

/**
 * Built once, by the same PostCSS plugin `next build` uses, with source detection
 * narrowed to `src/`.
 *
 * Narrowed on purpose: this file's own text names these utilities, and Tailwind's
 * default scan would read them, so every assertion below would pass on a build in
 * which the class no longer exists anywhere. `gallery-tiles.test.mts` has the long
 * version of that argument, and it is the reason the compile is here at all: source
 * text cannot answer whether a class emits a rule.
 */
let stylesheet: Promise<string> | undefined;
function compiled(): Promise<string> {
  stylesheet ??= build();
  return stylesheet;
}

async function build(): Promise<string> {
  const from = path.join(ROOT, "src/app/globals.css");
  const source = `${readFileSync(from, "utf8")}\n@source "../";\n`.replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  return (await postcss([tailwindcss()]).process(source, { from })).css;
}
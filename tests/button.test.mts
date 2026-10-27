/**
 * #425 — one `<Button>`, and the three boxes behind the four copies.
 *
 * Four call sites spelled a filled button out. `ContactForm` and
 * `PrintConfigurator` were byte-identical; `checkout/cancel` and
 * `checkout/success` are that button with the padding stepped down, and one of
 * them is a full-width link rather than an inline one. The issue asked for two
 * shapes when it was written; the tree holds three, and #425's own instruction —
 * collapse the difference if it is not deliberate — is not answerable from source,
 * so all three are named (`form`, `inline`, `block`) and rendered as they are.
 *
 * The one thing that must not happen in a lift like this is a restyle nobody
 * asked for: `form` is 2px taller than the other two and is the only one with a
 * shadow, and there is no visual-regression suite here to notice either way. So
 * the assertions here are pinned to the *literals the call sites used to render*,
 * byte for byte, and the extraction is only allowed to move the string, never
 * rewrite it.
 *
 * What each assertion is able to catch:
 *
 * - **each shape is the literal it replaced** — the zero-delta property, and the
 *   reason a reviewer can read this pull request without rendering anything;
 * - **the three shapes agree on the fill and the ink** — the drift guard for the
 *   one thing the table repeats three times. If `form` lost its hover step or
 *   `block` gained a different ink, the label's 17.49:1 would no longer be the
 *   number that was measured;
 * - **no call site writes a filled box again** — the structural half, which is
 *   what stops a fifth button from being a fifth drift;
 * - **all four call sites moved** — otherwise the extraction would be a new
 *   module nobody uses while the copies stay;
 * - **the rendered component is the rendered constant** — via the `.tsx` load hook
 *   from #420, so the props path is checked rather than assumed.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Button, buttonClass, type ButtonShape } from "../src/components/Button.tsx";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUTTON = "src/components/Button.tsx";

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
 * The className each shape rendered at its call site before #425, byte for byte,
 * with the label token spelled out because that is how the sites spelled it.
 *
 * Read these off the four call sites at `f0bec3a`:
 * `ContactForm.tsx:286` and `PrintConfigurator.tsx:511` (identical),
 * `checkout/cancel/page.tsx:26`, `checkout/success/page.tsx:92`.
 */
const LITERAL: Record<ButtonShape, string> = {
  form: "text-xs uppercase tracking-widest font-medium w-full bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white py-3.5 px-4 rounded transition-all shadow-sm",
  inline: "text-xs uppercase tracking-widest font-medium inline-block bg-stone-900 hover:bg-stone-800 text-white py-3 px-6 rounded transition-all",
  block: "text-xs uppercase tracking-widest font-medium inline-block w-full text-center bg-stone-900 hover:bg-stone-800 text-white py-3 rounded transition-all",
};

/** What all three boxes share, and must not stop sharing. */
const FILL = "bg-stone-900 hover:bg-stone-800";
const INK = "text-white";

test("each shape renders exactly the string its call site rendered", () => {
  for (const shape of ["form", "inline", "block"] as const) {
    assert.equal(
      buttonClass(shape),
      LITERAL[shape],
      `the ${shape} box is not what it was: this is a restyle, and it needs its own issue`,
    );
  }
});

/**
 * Render a button around some placeholder text. `children` is merged in before
 * `createElement`, for the reason `page-shell.test.mts` gives.
 */
function render(props: Omit<ComponentProps<typeof Button>, "children">): string {
  const element: ComponentProps<typeof Button> = { ...props, children: "Send" };
  return renderToStaticMarkup(createElement(Button, element));
}

test("<Button> renders the shape it was asked for", () => {
  // The props path, not the constant: a `shape` that is threaded through wrongly
  // would still pass the assertion above, which only ever calls `buttonClass`.
  for (const shape of ["form", "inline", "block"] as const) {
    const html = render({ shape });
    assert.ok(
      html.includes(`class="${LITERAL[shape]}"`),
      `the ${shape} button did not render its own box: ${html}`,
    );
  }
});

test("<Button> does not submit a form by accident", () => {
  // Both call sites say `type` today, so this decides the next one. HTML's
  // default for a `<button>` is `submit`, and a button inside a form that forgets
  // is the kind of bug that costs an order rather than showing up in a test.
  const html = render({ shape: "form" });
  assert.match(html, /type="button"/);
  assert.doesNotMatch(html, /type="submit"/);

  assert.match(render({ shape: "form", type: "submit" }), /type="submit"/);
});

test("a call site cannot add its own className", () => {
  // The type is the guard, because four call sites each spelling their own box is
  // how the boxes drifted. `@ts-expect-error` fails the test if the prop is ever
  // allowed back in.
  // @ts-expect-error className is omitted from Button's props on purpose
  const _rejected: ComponentProps<typeof Button> = { children: "Send", shape: "form", className: "mt-2" };
  assert.ok(_rejected);
});

test("an unknown shape is a compile error rather than a missing box", () => {
  const shapes: ButtonShape[] = ["form", "inline", "block"];
  assert.equal(shapes.length, 3);
  // @ts-expect-error a fourth spelling must not type-check
  const _rejected: ButtonShape = "compact";
  assert.equal(_rejected, "compact");
});

test("the three boxes agree on the fill and the ink", () => {
  // The table states each box as a whole literal so the rendered strings stay
  // byte-identical, which means the fill and the ink are written three times.
  // That is the one duplication here, so it gets a guard: a button whose fill
  // differs is still legible, and the label's contrast ratio would silently stop
  // being the one that was measured.
  for (const shape of ["form", "inline", "block"] as const) {
    const value = buttonClass(shape);
    for (const [what, token] of [["fill", FILL], ["ink", INK]] as const) {
      assert.ok(
        value.includes(token),
        `the ${shape} box lost its ${what} (\`${token}\`): the label's 17.49:1 was measured against it`,
      );
    }
    // Exactly once. A second fill would mean two of them and no way to tell which
    // Tailwind applies last.
    assert.equal(
      value.split(FILL).length - 1,
      1,
      `the ${shape} box states its fill more than once: ${value}`,
    );
  }
});

test("no call site spells a filled button box any more", () => {
  // Structural, like `gallery-tiles.test.mts`'s "only tile" assertion: four copies
  // that can drift is the problem this module exists to end, so a hand-written box
  // has to be a test failure rather than a reviewer's eye.
  const offenders: string[] = [];
  for (const file of srcFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (relative === BUTTON) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes(FILL)) offenders.push(relative);
  }
  assert.deepEqual(
    offenders,
    [],
    `these write a filled button box by hand; use <Button> or buttonClass():\n  ${offenders.join("\n  ")}`,
  );
});

test("every button moved, each onto its own shape", () => {
  // The two submit controls and the two checkout links, with the shape each one
  // renders. The counts are the point: a fifth button has to be added here too.
  const expected: readonly [file: string, shape: ButtonShape, count: number][] = [
    ["src/components/ContactForm.tsx", "form", 1],
    ["src/components/PrintConfigurator.tsx", "form", 1],
    ["src/app/[locale]/checkout/cancel/page.tsx", "inline", 1],
    ["src/app/[locale]/checkout/success/page.tsx", "block", 1],
    // The way back to the site from a page that does not exist.
    ["src/app/[locale]/not-found.tsx", "inline", 1],
  ];
  for (const [file, shape, count] of expected) {
    const source = sourceOf(file);
    const uses = source.match(new RegExp(`<Button\\b|buttonClass\\("${shape}"\\)`, "g")) ?? [];
    assert.equal(uses.length, count, `${file} should render ${count} \`${shape}\` button(s)`);
    assert.ok(
      !source.includes("BUTTON_LABEL"),
      `${file} reaches for the label token directly; take the whole box from Button`,
    );
  }

  // And nothing else renders one: a `<Button>` outside this list is a call site
  // this test has not been told about.
  const users = srcFiles().filter((file) => {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (relative === BUTTON) return false;
    return /<Button\b|buttonClass\(/.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(
    users.map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort(),
    expected.map(([file]) => file).sort(),
    "a button call site is missing from the list above",
  );
});
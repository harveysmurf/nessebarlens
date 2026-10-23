/**
 * The shared field styles, and the two forms that have to keep using them.
 *
 * `ContactForm` had already extracted its input and label classes into module
 * constants. `PrintConfigurator` wrote the same two strings as literals five and
 * six times, and the two files had drifted apart — `text-sm` against `text-xs`,
 * `mb-1.5` against `mb-1` — so "the field style" was a property of neither form
 * on its own. This module is the one place both spellings come from.
 *
 * The tests are split between the module (what the styles are) and the two
 * components (that they take their styles from here). The component tests read
 * source because the repo has no React render harness — see
 * `gallery-tiles.test.mts`, which pins a component the same way, and #418 step 2,
 * which is the change that would let these become render assertions.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  fieldControlClass,
  fieldErrorClass,
  fieldHintClass,
  fieldLabelClass,
  type FieldDensity,
} from "../src/components/field-styles";

function sourceOf(relative: string): string {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** The classes minus the one the test is about, so the rest can be compared. */
function without(tokens: string, dropped: string): string {
  return tokens
    .split(/\s+/)
    .filter((token) => token !== dropped)
    .join(" ");
}

test("the two field densities differ only in the control's text size", () => {
  // The whole point of naming the density: `compact` is the configurator's
  // denser panel and must not be free to change anything else about a control.
  // If the base drifts, or a density starts overriding padding or a border, the
  // two forms silently diverge again — which is what this module exists to stop.
  assert.equal(
    without(fieldControlClass("compact"), "text-xs"),
    without(fieldControlClass(), "text-sm"),
    "the two densities' controls differ by more than their text size",
  );
});

test("the two field densities differ only in the label's gap", () => {
  assert.equal(
    without(fieldLabelClass("compact"), "mb-1"),
    without(fieldLabelClass(), "mb-1.5"),
    "the two densities' labels differ by more than their bottom margin",
  );
});

test("an unknown density is a compile error rather than a missing style", () => {
  // `FieldDensity` is what makes a typo fail at build time; the runtime guard
  // is only here so the test file can prove the type is actually narrow.
  const densities: FieldDensity[] = ["default", "compact"];
  assert.deepEqual(Object.keys(densities).length, 2);
  // @ts-expect-error a third spelling must not type-check
  const _rejected: FieldDensity = "dense";
  assert.equal(_rejected, "dense");
});

test("the shared control style is the one both forms already rendered", () => {
  // Pinned as literals because this string *is* the design: it is what an
  // `<input>`, `<textarea>` and `<select>` look like across the whole site, and
  // changing it changes every form at once. A failure here is a restyle, and
  // should be read as one rather than worked around.
  assert.equal(
    fieldControlClass(),
    "w-full border border-stone-300 rounded p-2.5 text-sm bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900",
  );
  assert.equal(
    fieldLabelClass(),
    "block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1.5",
  );
  assert.equal(
    fieldControlClass("compact"),
    "w-full border border-stone-300 rounded p-2.5 text-xs bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900",
  );
  assert.equal(
    fieldLabelClass("compact"),
    "block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1",
  );
});

test("the error and hint lines are the ones the forms already rendered", () => {
  // Pinned for the reason the control is: these two strings are what a
  // visitor reads when the form refuses them, and a change to either is a
  // change to how every field in the site reports a problem.
  assert.equal(fieldErrorClass(), "text-[11px] text-red-700 mt-1.5");
  assert.equal(fieldHintClass(), "text-[10px] text-stone-500 mt-1.5");
});

/**
 * The literal both forms used to inline, which no component may spell again.
 *
 * Matched loosely on purpose: the point is that the *style* is not written out
 * in a component, so a partial copy — one changed colour, one missing focus
 * rule — is caught by matching the distinctive middle of the string rather than
 * an exact className that a typo would miss.
 */
const INLINED_FIELD_STYLE = /border-stone-300 rounded p-2\.5[^\n]*focus-visible:outline-stone-900/;
const INLINED_FIELD_LABEL = /font-semibold uppercase tracking-wider text-\[10px\] text-stone-600 mb-/;
/** The two lines a field is about, matched on their middle for the same reason. */
const INLINED_FIELD_ERROR = /text-\[11px\] text-red-700 mt-1\.5/;
const INLINED_FIELD_HINT = /text-\[10px\] text-stone-500 mt-1\.5/;

test("ContactForm takes its field styles from the shared module", () => {
  const source = sourceOf("../src/components/ContactForm.tsx");
  assert.doesNotMatch(
    source,
    INLINED_FIELD_STYLE,
    "ContactForm inlines the control style again; take it from field-styles",
  );
  assert.doesNotMatch(
    source,
    INLINED_FIELD_LABEL,
    "ContactForm inlines the label style again; take it from field-styles",
  );
  assert.doesNotMatch(
    source,
    INLINED_FIELD_ERROR,
    "ContactForm inlines the field error again; take it from field-styles",
  );
  assert.match(source, /fieldControlClass\(\)/);
  assert.match(source, /fieldLabelClass\(\)/);
});

test("PrintConfigurator takes its compact field styles from the shared module", () => {
  const source = sourceOf("../src/components/PrintConfigurator.tsx");
  assert.doesNotMatch(
    source,
    INLINED_FIELD_STYLE,
    "PrintConfigurator inlines the control style again; take it from field-styles",
  );
  assert.doesNotMatch(
    source,
    INLINED_FIELD_HINT,
    "PrintConfigurator inlines the field note again; take it from field-styles",
  );
  // The fieldset legend is not a field label — it names a grid of radio cards,
  // not one control, and it sits further above its content on purpose.
  assert.equal(
    source.match(new RegExp(INLINED_FIELD_LABEL.source, "g"))?.length,
    1,
    "only the fieldset legend should still spell the label style out",
  );
  assert.match(source, /fieldControlClass\("compact"\)/);
  assert.match(source, /fieldLabelClass\("compact"\)/);
});

test("every control and label in PrintConfigurator uses the shared style", () => {
  // Counts rather than greps, so a fifth literal in a sixth place fails as well
  // as a re-inline of one of the existing five.
  const source = sourceOf("../src/components/PrintConfigurator.tsx");
  assert.equal(source.match(/fieldControlClass\("compact"\)/g)?.length, 5);
  assert.equal(source.match(/fieldLabelClass\("compact"\)/g)?.length, 6);
});

test("every field error and every field note comes from the shared module", () => {
  // Counts as well as the regexes: the four errors in the contact form and the
  // three notes in the configurator are the ones this replaced, so a fifth
  // call site is a decision rather than an accident.
  const form = sourceOf("../src/components/ContactForm.tsx");
  assert.equal(form.match(/fieldErrorClass\(\)/g)?.length, 4);
  const configurator = sourceOf("../src/components/PrintConfigurator.tsx");
  assert.equal(configurator.match(/fieldHintClass\(\)/g)?.length, 3);
});

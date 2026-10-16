/**
 * The look of a labelled form control, shared by every form in the app.
 *
 * Both forms already agreed on it: `ContactForm` had extracted the two strings
 * into module constants, and `PrintConfigurator` wrote the same two strings as
 * literals five and seven times respectively. Those copies had already drifted —
 * `text-sm` against `text-xs`, `mb-1.5` against `mb-1` — so the property was
 * true of neither form as a whole, only of one file each.
 *
 * The base is written once here. The two differences are named rather than
 * re-spelled at each call site, because they are the only part a caller is
 * allowed to choose: the configurator is a dense panel inside a purchase card
 * and its controls are set one step smaller, which is a decision worth keeping
 * visible. Collapsing the remaining 2px gap between the two densities is a design
 * call and deliberately not made here.
 *
 * Both class strings are built by concatenation, but every Tailwind candidate is
 * a literal in this file: `DENSITY` spells `text-xs` / `text-sm` out rather than
 * interpolating `text-${size}`, because a class Tailwind cannot see is a class
 * that never lands in the stylesheet.
 */

/**
 * A field's control, split either side of the text-size slot.
 *
 * Split so the size lands between `p-2.5` and `bg-stone-50`, where it sat in the
 * literals this replaced. Token order in a class attribute does not change what
 * is computed, so this is not a correctness requirement — it is what makes the
 * rendered markup diff clean, which is how this change was verified.
 */
const CONTROL_HEAD = "w-full border border-stone-300 rounded p-2.5";
const CONTROL_TAIL =
  "bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

/** Everything a field's label has in common, at any density. */
const LABEL =
  "block font-semibold uppercase tracking-wider text-[10px] text-stone-600";

/**
 * How tightly a form is packed.
 *
 * - `default` — the contact form: a standalone page-width form, `text-sm`
 *   controls and a 6px gap under the label.
 * - `compact` — the print configurator: a panel inside a card whose own wrapper
 *   is already `text-xs`, so its controls match it, and a 4px label gap.
 */
export type FieldDensity = "default" | "compact";

const DENSITY: Record<FieldDensity, { control: string; label: string }> = {
  default: { control: "text-sm", label: "mb-1.5" },
  compact: { control: "text-xs", label: "mb-1" },
};

/** The className for a control — an `<input>`, `<textarea>` or `<select>`. */
export function fieldControlClass(density: FieldDensity = "default"): string {
  return `${CONTROL_HEAD} ${DENSITY[density].control} ${CONTROL_TAIL}`;
}

/** The className for the `<label>` or `<legend>` that names a control. */
export function fieldLabelClass(density: FieldDensity = "default"): string {
  return `${LABEL} ${DENSITY[density].label}`;
}
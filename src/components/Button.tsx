import type { ButtonHTMLAttributes } from "react";
import { BUTTON_LABEL } from "@/components/type-styles";

/**
 * The site's filled button — the four on the site that submit or carry you on.
 *
 * Four call sites spelled this out and there were three boxes behind them, not
 * the two #425 expected when it was written. `ContactForm` and
 * `PrintConfigurator` agreed byte for byte; `checkout/cancel` and
 * `checkout/success` are that button with `py-3` against `py-3.5`, and one of
 * them is a full-width link rather than an inline one.
 *
 * So there are three shapes, named for where the button goes rather than for how
 * big it is, and each is a whole literal rather than a base plus overrides:
 * #419 settled that naming the difference beats folding it away, because folding
 * it away is a restyle with no evidence behind it and no pixel test here to
 * catch it.
 *
 * Each shape is stated byte for byte as its call site rendered it, so the
 * extraction cannot move a pixel — `button.test.mts` pins each string against the
 * literal it replaced, and pins that the fill and the ink agree across all three.
 *
 * `form` is 2px taller and carries a shadow the other two do not. That has never
 * been established as deliberate: it is the current visual state of the two form
 * submits, recorded so the next change is a decision rather than an accident.
 * Whether that 2px should go is a separate issue with pixels in it.
 *
 * Every utility is a literal here for the reason `PhotoTile` says it is: Tailwind
 * reads file text, so a utility assembled in a template literal emits no rule.
 */

export type ButtonShape = "form" | "inline" | "block";

const SHAPE: Record<ButtonShape, string> = {
  /**
   * A form's submit, full width: the contact form's send and the configurator's
   * checkout. Dimmed while disabled, and the only one of the three carrying a
   * shadow and a half-step of extra vertical padding — current visual state, not
   * a reason anyone has established. See the note on the 2px above.
   */
  form: "w-full bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white py-3.5 px-4 rounded transition-all shadow-sm",
  /**
   * A button inline in a line of text, its own width: the link back to the print
   * page or the gallery from the cancelled checkout.
   */
  inline: "inline-block bg-stone-900 hover:bg-stone-800 text-white py-3 px-6 rounded transition-all",
  /**
   * A full-width anchor standing in for a button, as a download link does.
   * Centred, because a block-width link holds its text at the left otherwise.
   */
  block: "inline-block w-full text-center bg-stone-900 hover:bg-stone-800 text-white py-3 rounded transition-all",
};

/**
 * The className for a filled button in one of the three boxes.
 *
 * For the call sites that are not `<button>` — two checkout pages, where the
 * control is a link and has to navigate rather than submit.
 */
export function buttonClass(shape: ButtonShape): string {
  return `${BUTTON_LABEL} ${SHAPE[shape]}`;
}

/**
 * A `<button>`, in one of the three boxes.
 *
 * `type` defaults to `button` and not to the HTML default of `submit`: a button
 * inside a form that forgets to say which it is submits the form, and the one
 * place that reads as a convenience is the place it costs an order. Both call
 * sites say `type` explicitly today, so this only decides the next one.
 *
 * `className` is omitted from the props on purpose, and the box is applied after
 * the spread rather than before it. Four call sites each spelling their own box
 * is how the boxes drifted in the first place, and a second className is that
 * drift with extra steps: with the spread last, a className that reached here
 * anyway would replace the whole box rather than add to it, so the button would
 * render unstyled and still type-check as a filled one. Put the box in the shape
 * table, where the test can see it.
 */
export function Button({
  shape,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  /** Which of the three boxes. No default: choosing is the point. */
  shape: ButtonShape;
}) {
  return <button {...props} type={type} className={buttonClass(shape)} />;
}
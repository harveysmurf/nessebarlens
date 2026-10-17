/**
 * The site's small-uppercase-tracked type, shared by every surface that uses it.
 *
 * #424 found the eyebrow spelled four ways across twelve files — `tracking-[0.3em]`,
 * `tracking-widest`, `tracking-wider`, `tracking-[0.25em]` — and the split ran
 * straight through `tracking-widest`, which was eight sites when the issue was
 * written and fourteen by then. Six of those fourteen were byte-identical
 * `tracking-[0.3em]` eyebrows and four were byte-identical filled buttons; only
 * the rest differed, and they differed because they are not the same thing.
 *
 * So there are two tokens here, not one, and the reason is a surface.
 *
 * - `BUTTON_LABEL` is `text-white` on `bg-stone-900` — 17.49:1 against `stone-900`
 *   `#1c1917`, and its contrast is decided entirely by the button it lands on.
 * - `eyebrowClass` is `text-stone-500` on the page background — 4.53:1, and that
 *   is the value #423 spent an issue moving, with 0.03 to spare.
 *
 * Merged into one token, the second would be audited against the first's surface
 * and nobody would notice: the page eyebrow would inherit the button's
 * comfortable margin, or the button label would be checked against `#faf8f5`
 * instead of its own fill. That is precisely the class of bug #423 just fixed —
 * a light-on-dark site assumed to be checked light-on-light — so the two are
 * declared separately and `type-tokens.test.mts` holds each one to its own
 * surface. A fourth button or eyebrow must reach for a token, and adding a
 * colour to one is a contrast decision rather than a typo.
 *
 * Boxes stay at the call sites. The buttons genuinely differ in width, padding
 * and shadow, and choosing between them is a design call this change does not
 * make.
 */

/**
 * A button label on a filled background.
 *
 * Only the typography. The box — `w-full`, `px-6`, `shadow-sm`, `disabled:opacity-60`
 * — is the caller's, because those differ per button and are not part of the
 * contrast contract.
 *
 * Every use must sit on `bg-stone-900`; the test fails one that does not.
 */
export const BUTTON_LABEL = "text-xs uppercase tracking-widest font-medium";

/**
 * How prominently an eyebrow is set. Both were hand-tuned per site; they are
 * named here so the choice is visible instead of per-file.
 *
 * - `muted` — the default, and the six sites that already agreed: `text-stone-500`
 *   at 10px on the page background.
 * - `accent` — one site, the home page's category eyebrow, which is amber because
 *   it sits on a photo tile and reads as a caption rather than as chrome.
 * - `signature` — the header's tagline, one step smaller so it fits beside the
 *   wordmark at every breakpoint above `sm`.
 */
export type EyebrowTone = "muted" | "accent" | "signature";

const EYEBROW: Record<EyebrowTone, { size: string; colour: string }> = {
  muted: { size: "text-[10px]", colour: "text-stone-500" },
  accent: { size: "text-[10px]", colour: "text-amber-200" },
  signature: { size: "text-[9px]", colour: "text-stone-500" },
};

/**
 * The page's eyebrow: a tiny uppercase tracked label above a heading or block.
 *
 * `tracking-[0.3em]` is 0.3em, not Tailwind's `tracking-widest` (0.1em). That is
 * not a rounding difference — at 10px it is 3px of letter spacing against 1px,
 * which is the difference between a label and a word. Six sites spelled it out and
 * the token spells it once, so the next eyebrow cannot pick the other one.
 *
 * `accent` is declared against a photo tile rather than the page, so it is the
 * one tone this token does not audit against `--gallery-50`.
 */
export function eyebrowClass(tone: EyebrowTone = "muted"): string {
  const { size, colour } = EYEBROW[tone];
  return `${size} uppercase tracking-[0.3em] ${colour} font-medium`;
}
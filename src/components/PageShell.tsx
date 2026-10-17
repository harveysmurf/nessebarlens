import type { ReactNode } from "react";

/**
 * The page's centred column: a max width, one gutter, and vertical padding.
 *
 * Nine call sites wrote it out. `SiteHeader` and `SiteFooter` each re-spelled
 * `max-w-7xl mx-auto px-6` — the container width the other seven are all trying
 * to express — and `checkout/cancel` and `checkout/success` wrote a byte-identical
 * shell each. The widths and the padding are real variation and are props:
 *
 * | site                    | width | padding |
 * | ----------------------- | ----- | ------- |
 * | `checkout/cancel`       | `lg`  | `20`    |
 * | `checkout/success`      | `lg`  | `20`    |
 * | `prints/[slug]`         | `7xl` | `10`    |
 * | `GalleryPage`           | `7xl` | `12`    |
 * | `page.tsx` (home)       | `7xl` | `10`, 16 bottom |
 * | `story`                 | `5xl` | `16`    |
 * | `contact`               | `2xl` | `16`    |
 * | `SiteHeader`            | `7xl` | none — `containerClass` |
 * | `SiteFooter`            | `7xl` | none — `containerClass` |
 *
 * Both maps are literal for the reason `PhotoTile` spells out: Tailwind reads
 * file text, so `py-${padding}` would emit no rule at all and every shell would
 * lose its vertical padding with nothing failing. `page-shell.test.mts` compiles
 * the stylesheet and asks.
 *
 * The element is a `<div>`, and the `fade-in` section stays at the call site.
 * Three pages already had one around a `<div>` shell; four had the shell *be* the
 * section, and putting the shell inside the section they already needed leaves
 * the animation where the page has a landmark and no page with a bare `<section>`
 * wrapping a container div. `fadeIn` moves `opacity` and `translateY(8px)`, and
 * neither depends on which of the two carries it.
 */
export type ShellWidth = "lg" | "2xl" | "5xl" | "7xl";

const WIDTH: Record<ShellWidth, string> = {
  lg: "max-w-lg",
  "2xl": "max-w-2xl",
  "5xl": "max-w-5xl",
  "7xl": "max-w-7xl",
};

/** The gutter, in the order the nine call sites wrote it. */
const GUTTER = "mx-auto px-6";

/**
 * Vertical padding, as the Tailwind step. Only the steps the site uses are
 * declared: an unused one is a claim that no page needs it.
 */
export type ShellPadding = 10 | 12 | 16 | 20;

const PADDING: Record<ShellPadding, string> = {
  10: "py-10",
  12: "py-12",
  16: "py-16",
  20: "py-20",
};

/**
 * The container without vertical padding — the header's and the footer's bar.
 *
 * `PageShell` would mean two props nothing passes, so the two chrome elements
 * take the width alone. Both are `7xl` today, and both say so at the call site.
 */
export function containerClass(width: ShellWidth): string {
  return `${WIDTH[width]} ${GUTTER}`;
}

/**
 * The page's centred column, with vertical padding.
 *
 * `className` is the caller's own classes — `space-y-*`, `text-center`, and the
 * one asymmetric shell. Anything that reads the padding is not for `className`:
 * the home page sets `pb-16` on top of `py-10`, which works because Tailwind emits
 * `.pb-16` after `.py-10` at the same specificity, and
 * `page-shell.test.mts` asserts that order in the compiled stylesheet rather than
 * taking it on trust. A wrapper would be the other way to hold the 6px.
 */
export function PageShell({
  width,
  padding,
  className,
  children,
}: {
  width: ShellWidth;
  padding: ShellPadding;
  /** Passed through after the shell's own classes. */
  className?: string;
  children: ReactNode;
}) {
  const classes = [containerClass(width), PADDING[padding], className].filter(
    (value): value is string => Boolean(value),
  );
  return <div className={classes.join(" ")}>{children}</div>;
}
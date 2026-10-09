/**
 * Money, as one validated representation.
 *
 * A EUR amount is a bare `number` in three shapes at once in this codebase: a
 * float coming back from Prodigi, a float in Stripe metadata, an integer in
 * cents going to Stripe. The rules that make a number a valid EUR amount --
 * not negative, at most six integer digits, at most two decimals -- are
 * written down only in the grammar below, so every path that reads an amount
 * goes through it and no path can carry a sub-cent amount to Stripe.
 *
 * `Eur` is that path made explicit: whole cents behind a brand, one grammar
 * for reading a string, one entry point for writing, and every operation
 * returning another `Eur`. A bare number cannot stand in for one, and one
 * does not leave this module except as whole cents, as a two-decimal string,
 * or as the float EUR that Stripe metadata, the API and the frozen v1 record
 * speak (`cents() / 100`). The record itself stays `number`: `OrderRecord` is
 * a byte-frozen storage format, so `Eur` is used where an amount is read or
 * computed, never stored.
 */

/**
 * The brand that makes `Eur` opaque: only this module can build one. A
 * runtime symbol so the marker is invisible to JSON.stringify and to
 * util.inspect -- an `Eur` travels in memory, and the record keeps its plain
 * number.
 */
const EUR_BRAND: unique symbol = Symbol("Eur");

/** 999999.99 EUR in whole cents: the six integer digits the grammar admits. */
const MAX_CENTS = 99_999_999;

/**
 * The EUR grammar, declared here and nowhere else (ownership pinned by
 * tests/single-source-grammar.test.mts): a plain non-negative decimal with at
 * most six integer digits and at most two decimals. No sign, no exponent, no
 * thousands separator, no leading zeros -- each of those is either a
 * different amount or not an amount, and a reader that guesses which has no
 * way to tell.
 */
const EUR_GRAMMAR = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;

export type Eur = {
  readonly [EUR_BRAND]: true;
  /** Whole cents. The one number that leaves as itself. */
  cents(): number;
  add(other: Eur): Eur;
  /** Scale by a ratio, rounding to the nearest whole cent. */
  multiplyBy(ratio: number): Eur;
  isZero(): boolean;
  /** Two decimals as a decimal string: "30.00", "0.05", "11.99". */
  toFixed(): string;
};

/**
 * The single construction point, so the bounds are checked once instead of
 * once per entry point. An out-of-range value is a programming error rather
 * than a customer error: the grammar already refuses everything a customer
 * can send, so only internal arithmetic can get here with a bad number --
 * a margin that overruns the cap, an add that carries past it.
 */
function makeEur(cents: number): Eur {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    throw new Error(`invalid EUR cents: ${cents}`);
  }
  return {
    [EUR_BRAND]: true,
    cents: () => cents,
    add: (other: Eur) => makeEur(cents + other.cents()),
    multiplyBy: (ratio: number) => makeEur(Math.round(cents * ratio)),
    isZero: () => cents === 0,
    toFixed: () => (cents / 100).toFixed(2),
  };
}

export const Eur = {
  /** Read from whole cents. Non-integers, negatives and over-cap all throw. */
  fromCents(cents: number): Eur {
    return makeEur(cents);
  },
  zero(): Eur {
    return makeEur(0);
  },
};

/**
 * The one EUR to cents rounding in the repo. The Stripe line items, the
 * amount guard on the webhook and the read path all compare against it, so a
 * second rounding would be a second answer to "how many cents is this
 * amount".
 */
export function eurToCents(eur: number): number {
  return Math.round(eur * 100);
}

/**
 * Read a decimal EUR string as it arrives over the wire (Prodigi quotes,
 * stored order metadata) into an `Eur`. Null for anything that is not a
 * plain non-negative amount with at most two decimals.
 */
export function parseEur(raw: string | null | undefined): Eur | null {
  if (!raw || !EUR_GRAMMAR.test(raw)) return null;
  return makeEur(eurToCents(Number(raw)));
}

/**
 * The same read as `parseEur`, returned as the float EUR that Stripe
 * metadata, the API and the frozen v1 record speak. Reading through `parseEur`
 * keeps the grammar and the rounding in one place: for every string the
 * grammar admits, `cents() / 100` and `Number(raw)` are the same double,
 * because a two-decimal amount rounded to whole cents and back rounds to
 * itself.
 */
export function parseEurAmount(raw: string | null | undefined): number | null {
  const value = parseEur(raw);
  return value === null ? null : value.cents() / 100;
}

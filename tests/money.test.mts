import assert from "node:assert/strict";
import test from "node:test";
import {
  Eur,
  eurToCents,
  parseEur,
  parseEurAmount,
} from "../src/lib/money.ts";
import * as pricing from "../src/lib/pricing.ts";

test("parseEur reads every amount the grammar admits", () => {
  for (const raw of ["0", "12.5", "12.50", "123456.78"]) {
    const eur = parseEur(raw);
    assert.ok(eur, raw);
    assert.equal(eur.cents(), eurToCents(Number(raw)), raw);
    assert.equal(parseEurAmount(raw), Number(raw), raw);
  }
});

test("parseEur refuses everything that is not a plain EUR amount", () => {
  // Empty, non-numeric, exponent notation, thousands separator, leading
  // zeros, a sign, more than two decimals, a bare fraction, and the six-digit
  // integer cap -- each of which is either a different amount or not one.
  for (const bad of [
    "",
    null,
    undefined,
    "abc",
    "1e3",
    "1,000",
    "012",
    "-1",
    "12.505",
    ".5",
    "1234567",
    "1234567.89",
  ]) {
    const raw = bad as string | null;
    assert.equal(parseEur(raw), null, String(bad));
    assert.equal(parseEurAmount(raw), null, String(bad));
  }
});

test("pricing hands out money's parse rather than a second one", () => {
  // pricing keeps the import path every caller already uses; if it ever grows
  // its own body, the two would agree until they did not.
  assert.equal(pricing.parseEurAmount, parseEurAmount);
  assert.equal(pricing.eurToCents, eurToCents);
});

test("eurToCents is the one rounding to whole cents", () => {
  assert.equal(eurToCents(30), 3000);
  assert.equal(eurToCents(19.995), 2000);
});

test("fromCents admits whole cents inside the cap and refuses the rest", () => {
  assert.equal(Eur.fromCents(0).cents(), 0);
  assert.equal(Eur.fromCents(99_999_999).cents(), 99_999_999);
  for (const bad of [1.5, -1, 100_000_000]) {
    assert.throws(() => Eur.fromCents(bad), /invalid EUR cents/, String(bad));
  }
});

test("zero is an amount, not an absence", () => {
  const zero = Eur.zero();
  assert.equal(zero.cents(), 0);
  assert.equal(zero.isZero(), true);
  assert.equal(zero.toFixed(), "0.00");
  assert.equal(Eur.fromCents(1).isZero(), false);
});

test("add works in cents and cannot leave the range", () => {
  assert.equal(Eur.fromCents(1199).add(Eur.fromCents(801)).cents(), 2000);
  assert.equal(Eur.zero().add(Eur.fromCents(7)).cents(), 7);
  assert.throws(
    () => Eur.fromCents(99_999_999).add(Eur.fromCents(1)),
    /invalid EUR cents/,
  );
});

test("multiplyBy scales whole cents and rounds the result", () => {
  // 9.99 EUR at the Prodigi margin: the scaled cents land on .8, which has to
  // round the same way the float arithmetic did, because the quote feeds
  // Stripe straight from this number.
  assert.equal(Eur.fromCents(999).multiplyBy(1.2).cents(), 1199);
  assert.equal(Eur.fromCents(1000).multiplyBy(1.2).cents(), 1200);
  assert.equal(Eur.fromCents(1123).multiplyBy(1.2).cents(), 1348);
  assert.equal(Eur.fromCents(0).multiplyBy(1.2).cents(), 0);
  // A ratio that would produce a negative or over-cap amount is refused by
  // the same bounds every other construction goes through.
  assert.throws(
    () => Eur.fromCents(10).multiplyBy(-1),
    /invalid EUR cents/,
  );
  assert.throws(
    () => Eur.fromCents(99_999_999).multiplyBy(2),
    /invalid EUR cents/,
  );
});

test("toFixed always shows both decimals", () => {
  assert.equal(Eur.fromCents(3000).toFixed(), "30.00");
  assert.equal(Eur.fromCents(5).toFixed(), "0.05");
  assert.equal(Eur.fromCents(12_345_678).toFixed(), "123456.78");
});

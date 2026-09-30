import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const HEADER = fs.readFileSync(
  new URL("../src/components/SiteHeader.tsx", import.meta.url),
  "utf8",
);

test("the active nav link is marked with aria-current=\"page\"", () => {
  // The active link was signalled by border/colour alone, so assistive tech
  // had no way to tell where you are in the site.
  assert.match(HEADER, /aria-current=\{active \? "page" : undefined\}/);
});

test("inactive nav links omit aria-current rather than asserting false", () => {
  // aria-current="false" is noisy for screen readers; the attribute should be
  // absent on links that are not current.
  assert.doesNotMatch(HEADER, /aria-current=\{active\}/);
  assert.doesNotMatch(HEADER, /aria-current="false"/);
});

test("aria-current is bound to the same active predicate as the styling", () => {
  const active = HEADER.match(/const active = ([^\n]+);/);
  assert.ok(active, "the active predicate should still be computed");
  assert.match(HEADER, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(HEADER, /active\s*\?\s*"border-stone-900 text-stone-900"/);
});

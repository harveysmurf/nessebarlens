import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path: string) =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8");

const LAYOUT = read("../src/app/layout.tsx");

test("the root <html> declares smooth scroll to Next, not only to the browser", () => {
  // `scroll-smooth` sets `scroll-behavior: smooth`, but Next 16 only neutralises
  // smooth scrolling during route transitions when `<html>` carries
  // `data-scroll-behavior="smooth"`. Without the attribute it logs a dev warning
  // and leaves the transition scrolling smoothly (#331 follow-up). e2e/
  // scroll-behavior.spec.ts asserts the warning is actually gone in a browser;
  // this pins the two attributes together in the source so they cannot drift.
  assert.match(
    LAYOUT,
    /<html[^>]*className="[^"]*\bscroll-smooth\b[^"]*"[^>]*data-scroll-behavior="smooth"/,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path: string) =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8");

const NAV = read("../src/components/nav.ts");
const HEADER = read("../src/components/SiteHeader.tsx");
const MOBILE = read("../src/components/MobileNav.tsx");

test("one NAV array is the source of truth for desktop and mobile", () => {
  // The desktop nav and the mobile panel must read the same list, or a new
  // destination silently appears on one and not the other (#331).
  assert.match(NAV, /export const NAV = \[/);
  assert.match(HEADER, /import \{ NAV, isActive \} from "\.\/nav"/);
  assert.match(MOBILE, /import \{ NAV, isActive \} from "\.\/nav"/);
  // Neither file may define its own copy.
  assert.doesNotMatch(HEADER, /const NAV = \[/);
  assert.doesNotMatch(MOBILE, /const NAV = \[/);
});

test("the toggle is a labelled button wired to the panel", () => {
  assert.match(MOBILE, /aria-expanded=\{open\}/);
  assert.match(MOBILE, /aria-controls=\{PANEL_ID\}/);
  assert.match(MOBILE, /aria-label=\{open \? "Close menu" : "Open menu"\}/);
  assert.match(MOBILE, /<nav aria-label="Main"/);
});

test("the active route carries aria-current on mobile as it does on desktop", () => {
  assert.match(MOBILE, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(MOBILE, /isActive\(pathname, item\.href\)/);
});

test("the mobile menu closes on Escape, route change and resize to md+", () => {
  // Route-change close is structural: open state is keyed to the pathname, so
  // a navigation flips it without an effect (react-hooks/set-state-in-effect).
  assert.match(MOBILE, /const open = openedAt === pathname/);
  assert.match(MOBILE, /event\.key === "Escape"/);
  assert.match(MOBILE, /window\.matchMedia\(DESKTOP_QUERY\)/);
});

test("body scroll is locked while the panel is open and restored on close", () => {
  assert.match(MOBILE, /root\.style\.overflow = "hidden"/);
  assert.match(MOBILE, /body\.style\.overflow = "hidden"/);
  assert.match(MOBILE, /root\.style\.overflow = previousRoot/);
});

test("focus moves into the panel and Tab is trapped within it and the toggle", () => {
  assert.match(MOBILE, /\.focus\(\)/);
  assert.match(MOBILE, /event\.key !== "Tab"/);
  assert.match(MOBILE, /\[toggleRef\.current, \.\.\.panelLinks\]/);
});

test("the panel is portaled out of the header's blurred containing block", () => {
  // `backdrop-blur` on the header makes it the containing block for a
  // `position: fixed` descendant, which collapsed the panel to 80px when it
  // lived inside SiteHeader. The portal keeps it full-screen (#331).
  assert.match(MOBILE, /import \{ createPortal \} from "react-dom"/);
  assert.match(MOBILE, /createPortal\(/);
  assert.match(MOBILE, /document\.body/);
});

test("motion respects prefers-reduced-motion", () => {
  assert.match(MOBILE, /motion-reduce:animate-none/);
  assert.match(MOBILE, /motion-reduce:transition-none/);
});

/**
 * Colour arithmetic, shared by the tests that assert on contrast.
 *
 * It lives here rather than inline because there are now two of them and WCAG's
 * definitions are exact: a second copy of `relativeLuminance` is a second thing
 * to keep correct, and a wrong copy makes a contrast assertion confidently wrong.
 *
 * From the WCAG 2.2 definitions and CSS Color 4. Both are pure functions on
 * values the caller supplies — nothing here knows the project's palette.
 */

/** Channels are 0–1; sRGB transfer function. */
function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => linearize(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio: (lighter + 0.05) / (darker + 0.05). */
export function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `#faf8f5` → `[250, 248, 245]`. Asserts the shape, so a typo is not a number. */
export function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`expected a six-digit hex, got ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * CSS Color 4 `oklch()` → an sRGB hex, clamped per channel.
 *
 * Good to about one channel, because the `oklch()` values Tailwind publishes
 * have lightness rounded to one decimal. That is fine for a threshold decision —
 * the pairs being separated are 2.38 and 4.53 — and not fine for an exact
 * colour identity, which is why callers assert on a declared hex and use this
 * only to check the declaration still matches what ships.
 */
export function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  const h = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channels = linear.map((v) => {
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  });
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
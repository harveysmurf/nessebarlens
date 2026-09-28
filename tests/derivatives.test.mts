import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
  webDerivativeUrls,
  webImagesBase,
} from "../src/lib/derivatives.ts";

function withBase<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.NEXT_PUBLIC_WEB_IMAGES_BASE;
  try {
    if (value === undefined) delete process.env.NEXT_PUBLIC_WEB_IMAGES_BASE;
    else process.env.NEXT_PUBLIC_WEB_IMAGES_BASE = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_WEB_IMAGES_BASE;
    else process.env.NEXT_PUBLIC_WEB_IMAGES_BASE = saved;
  }
}

test("webImagesBase rejects non-https, relative, and unset values", () => {
  for (const raw of [
    undefined,
    "",
    "   ",
    "http://cdn.example.com",
    "/relative/path",
    "not a url",
  ]) {
    withBase(raw, () => {
      assert.equal(webImagesBase(), undefined, JSON.stringify(raw));
      assert.equal(webDerivativeUrls("dawn"), null, JSON.stringify(raw));
    });
  }
});

test("webImagesBase normalizes trailing slashes and keeps the path", () => {
  withBase("https://cdn.example.com/gallery///", () => {
    assert.equal(webImagesBase(), "https://cdn.example.com/gallery");
  });
  withBase("  https://cdn.example.com/  ", () => {
    assert.equal(webImagesBase(), "https://cdn.example.com");
  });
});

test("every rung in WEB_DERIVATIVE_WIDTHS gets a URL, and only those", () => {
  withBase("https://cdn.example.com/g", () => {
    const out = webDerivativeUrls("dawn");
    assert.ok(out);
    assert.deepEqual(
      Object.keys(out.urls).map(Number).sort((a, b) => a - b),
      [...WEB_DERIVATIVE_WIDTHS].sort((a, b) => a - b),
    );
    for (const width of WEB_DERIVATIVE_WIDTHS) {
      assert.equal(
        out.urls[width],
        `https://cdn.example.com/g/dawn/${width}.jpg`,
      );
    }
  });
});

test("srcSet covers every width, and src is the declared default", () => {
  withBase("https://cdn.example.com/g", () => {
    const out = webDerivativeUrls("dawn");
    assert.ok(out);
    assert.equal(out.src, out.urls[WEB_DEFAULT_WIDTH]);
    const entries = out.srcSet.split(", ");
    assert.equal(entries.length, WEB_DERIVATIVE_WIDTHS.length);
    for (const width of WEB_DERIVATIVE_WIDTHS) {
      assert.ok(
        entries.includes(`${out.urls[width]} ${width}w`),
        `srcSet missing ${width}w`,
      );
    }
  });
});

test("drift guard: dropping a rung changes the URL set and srcSet length", () => {
  // WEB_DERIVATIVE_WIDTHS is the only list; urls/srcSet are built from it.
  assert.equal(WEB_DERIVATIVE_WIDTHS.length, 3);
  assert.equal(WEB_DEFAULT_WIDTH, 1500);
  assert.ok(WEB_DERIVATIVE_WIDTHS.includes(WEB_DEFAULT_WIDTH));
});

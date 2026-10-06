import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_FORMATS,
  WEB_DERIVATIVE_WIDTHS,
} from "../src/lib/derivative-ladder.ts";
import { webDerivativeUrls } from "../src/lib/derivatives.ts";
import { webImagesBase } from "../src/lib/config.ts";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE = "NEXT_PUBLIC_WEB_IMAGES_BASE";
const FLAG = "NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED";
const BASE_URL = "https://cdn.example.com/g";
const HASH = "abcdef12";
const PHOTO = { slug: "dawn", imageHash: HASH };

/** Both env vars as the ladder needs them to be on. */
function on(base = BASE_URL) {
  return { [BASE]: base, [FLAG]: "true" };
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
    withEnv({ ...on(), [BASE]: raw }, () => {
      assert.equal(webImagesBase(), undefined, JSON.stringify(raw));
      assert.equal(webDerivativeUrls(PHOTO), null, JSON.stringify(raw));
    });
  }
});

test("webImagesBase normalizes trailing slashes and keeps the path", () => {
  withEnv({ [BASE]: "https://cdn.example.com/gallery///" }, () => {
    assert.equal(webImagesBase(), "https://cdn.example.com/gallery");
  });
  withEnv({ [BASE]: "  https://cdn.example.com/  " }, () => {
    assert.equal(webImagesBase(), "https://cdn.example.com");
  });
});

test("a configured base alone does not turn the ladder on", () => {
  // The exact state this repo was in: the base set in every environment,
  // both buckets empty. Serving here would 404 the whole storefront.
  for (const flag of [undefined, "", "   ", "false", "no", "off", "0", "maybe"]) {
    withEnv({ [BASE]: BASE_URL, [FLAG]: flag }, () => {
      assert.equal(
        webDerivativeUrls(PHOTO),
        null,
        `flag ${JSON.stringify(flag)} must not enable the ladder`,
      );
    });
  }
});

test("the flag is opt-in and accepts only true or 1", () => {
  for (const flag of ["true", "TRUE", " true ", "1"]) {
    withEnv({ ...on(), [FLAG]: flag }, () => {
      assert.ok(webDerivativeUrls(PHOTO), `flag ${JSON.stringify(flag)} should enable the ladder`);
    });
  }
});

test("enabled but with no usable base still serves nothing", () => {
  withEnv({ [BASE]: undefined, [FLAG]: "true" }, () => {
    assert.equal(webDerivativeUrls(PHOTO), null);
  });
});

test("a photo without an image hash has no derivative to serve", () => {
  // A catalog entry is a placeholder until the publish script writes its hash.
  withEnv(on(), () => {
    assert.equal(webDerivativeUrls({ slug: "dawn" }), null);
    assert.equal(webDerivativeUrls({ slug: "dawn", imageHash: "" }), null);
  });
});

test("every rung gets a jpeg and a webp URL under {slug}/{hash}/{width}.{ext}", () => {
  withEnv(on(), () => {
    const out = webDerivativeUrls(PHOTO);
    assert.ok(out);
    assert.deepEqual(
      Object.keys(out.jpeg).map(Number).sort((a, b) => a - b),
      [...WEB_DERIVATIVE_WIDTHS].sort((a, b) => a - b),
    );
    for (const width of WEB_DERIVATIVE_WIDTHS) {
      assert.equal(
        out.jpeg[width],
        `https://cdn.example.com/g/dawn/${HASH}/${width}.jpg`,
      );
      assert.equal(
        out.webp[width],
        `https://cdn.example.com/g/dawn/${HASH}/${width}.webp`,
      );
    }
  });
});

test("src is the default-rung jpeg, and both srcsets cover every width", () => {
  withEnv(on(), () => {
    const out = webDerivativeUrls(PHOTO);
    assert.ok(out);
    assert.equal(out.src, out.jpeg[WEB_DEFAULT_WIDTH]);
    for (const [set, ext] of [
      [out.srcSet, "jpg"],
      [out.webpSrcSet, "webp"],
    ] as const) {
      const entries = set.split(", ");
      assert.equal(entries.length, WEB_DERIVATIVE_WIDTHS.length);
      for (const width of WEB_DERIVATIVE_WIDTHS) {
        assert.ok(
          entries.includes(
            `https://cdn.example.com/g/dawn/${HASH}/${width}.${ext} ${width}w`,
          ),
          `srcset missing ${width}w ${ext}`,
        );
      }
    }
  });
});

test("drift guard: the ladder is four widths in two formats", () => {
  assert.deepEqual([...WEB_DERIVATIVE_WIDTHS], [400, 750, 1500, 2000]);
  assert.equal(WEB_DEFAULT_WIDTH, 1500);
  assert.ok(WEB_DERIVATIVE_WIDTHS.includes(WEB_DEFAULT_WIDTH));
  assert.deepEqual([...WEB_DERIVATIVE_FORMATS], ["jpg", "webp"]);
});

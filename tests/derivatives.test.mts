import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_DEFAULT_WIDTH,
  WEB_DERIVATIVE_WIDTHS,
} from "../src/lib/derivative-ladder.ts";
import { webDerivativeUrls, webImagesBase } from "../src/lib/derivatives.ts";

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
      assert.equal(webDerivativeUrls("dawn"), null, JSON.stringify(raw));
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
        webDerivativeUrls("dawn"),
        null,
        `flag ${JSON.stringify(flag)} must not enable the ladder`,
      );
    });
  }
});

test("the flag is opt-in and accepts only true or 1", () => {
  for (const flag of ["true", "TRUE", " true ", "1"]) {
    withEnv({ ...on(), [FLAG]: flag }, () => {
      assert.ok(webDerivativeUrls("dawn"), `flag ${JSON.stringify(flag)} should enable the ladder`);
    });
  }
});

test("enabled but with no usable base still serves nothing", () => {
  withEnv({ [BASE]: undefined, [FLAG]: "true" }, () => {
    assert.equal(webDerivativeUrls("dawn"), null);
  });
});

test("every rung in WEB_DERIVATIVE_WIDTHS gets a URL, and only those", () => {
  withEnv(on(), () => {
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
  withEnv(on(), () => {
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

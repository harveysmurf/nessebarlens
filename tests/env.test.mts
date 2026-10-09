import assert from "node:assert/strict";
import test from "node:test";
import { envFlag, envIntInRange, envString, envStringStrippedSlash } from "../src/infrastructure/config/env.ts";
import { stripTrailingSlashes } from "../src/domain/pricing/url-patterns.ts";
import { readProdigiConfig } from "../src/infrastructure/prodigi/prodigi-config.ts";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("envString trims, rejects empty/whitespace/non-string", () => {
  assert.equal(envString("X", { X: "  a  " }), "a");
  assert.equal(envString("X", { X: "" }), undefined);
  assert.equal(envString("X", { X: "   " }), undefined);
  assert.equal(envString("X", { X: 42 }), undefined);
  assert.equal(envString("MISSING", {}), undefined);
});

test("envString prefers worker env over process.env", () => {
  withEnv("X", "from-process", () => {
    assert.equal(envString("X", { X: "from-env" }), "from-env");
    assert.equal(envString("X", {}), "from-process");
    // A blank worker value must not shadow a usable process.env value.
    assert.equal(envString("X", { X: "  " }), "from-process");
  });
});

test("envStringStrippedSlash drops one trailing slash, rejects bare slash", () => {
  assert.equal(envStringStrippedSlash("X", { X: "https://a/" }), "https://a");
  assert.equal(envStringStrippedSlash("X", { X: "https://a" }), "https://a");
  assert.equal(envStringStrippedSlash("X", { X: "/" }), undefined);
});

test("readProdigiConfig strips a trailing slash before the allowlist check", () => {
  assert.deepEqual(
    readProdigiConfig({
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com/",
      PRODIGI_SANDBOX_API_KEY: "sbx",
    }),
    { ok: true, base: "https://api.sandbox.prodigi.com", key: "sbx" },
  );
  assert.equal(
    readProdigiConfig({ PRODIGI_API_BASE: "https://evil.example" }).ok,
    false,
  );
});

test("readProdigiConfig pairs the sandbox host with the sandbox key only", () => {
  withEnv("PRODIGI_SANDBOX_API_KEY", "sbx", () =>
    withEnv("PRODIGI_API_KEY", "live", () => {
      const sandbox = { PRODIGI_API_BASE: "https://api.sandbox.prodigi.com" };
      assert.equal(readProdigiConfig(sandbox).key, "sbx");
      assert.equal(
        readProdigiConfig({ ...sandbox, PRODIGI_SANDBOX_API_KEY: "" }).key,
        "sbx",
      );
      // Sandbox host with only the live key must not silently use it.
      withEnv("PRODIGI_SANDBOX_API_KEY", undefined, () => {
        assert.equal(
          readProdigiConfig({ ...sandbox, PRODIGI_SANDBOX_API_KEY: undefined })
            .ok,
          false,
        );
        // Live host, live key.
        assert.equal(
          readProdigiConfig({ PRODIGI_API_BASE: "https://api.prodigi.com" })
            .key,
          "live",
        );
      });
    }),
  );
});

test("stripTrailingSlashes removes every trailing slash, not just one", () => {
  assert.equal(stripTrailingSlashes("https://a"), "https://a");
  assert.equal(stripTrailingSlashes("https://a/"), "https://a");
  assert.equal(stripTrailingSlashes("https://a///"), "https://a");
  assert.equal(stripTrailingSlashes("https://a/b//"), "https://a/b");
  assert.equal(stripTrailingSlashes("/"), "");
  assert.equal(stripTrailingSlashes(""), "");
  // A path-internal slash is not a trailing slash.
  assert.equal(stripTrailingSlashes("https://a/b"), "https://a/b");
  assert.equal(stripTrailingSlashes("https://a/?x=1"), "https://a/?x=1");
});

test("envFlag is opt-in: only true or 1 turn a gate on", () => {
  assert.equal(envFlag("X", { X: "true" }), true);
  assert.equal(envFlag("X", { X: "TRUE" }), true);
  assert.equal(envFlag("X", { X: " true " }), true);
  assert.equal(envFlag("X", { X: "1" }), true);
  // Deliberately strict: these callers gate things that 404 rather than
  // things that merely degrade, so a surprising value fails closed.
  for (const value of ["yes", "on", "enabled", "0", "false", "", "   ", "true1", "01"]) {
    assert.equal(envFlag("X", { X: value }), false, JSON.stringify(value));
  }
  assert.equal(envFlag("X", {}), false);
  assert.equal(envFlag("X", { X: 42 }), false);
});

test("envIntInRange falls back on anything it cannot use as a number", () => {
  // The download limit and token lifetime are configured through this, and a
  // paid download must degrade to the documented default rather than break:
  // so unset, non-numeric, fractional, below the floor, and unsafe all fall
  // back, and only an in-range integer is taken.
  assert.equal(envIntInRange("X", {}, 5, 1), 5, "unset");
  assert.equal(envIntInRange("X", { X: "  " }, 5, 1), 5, "blank");
  assert.equal(envIntInRange("X", { X: "abc" }, 5, 1), 5, "not a number");
  assert.equal(envIntInRange("X", { X: "3.5" }, 5, 1), 5, "fractional");
  assert.equal(envIntInRange("X", { X: "0" }, 5, 1), 5, "below the floor");
  assert.equal(envIntInRange("X", { X: "-2" }, 5, 1), 5, "negative below the floor");
  assert.equal(envIntInRange("X", { X: "1e9" }, 5, 1), 5, "exponent is not an integer literal");
  assert.equal(envIntInRange("X", { X: "Infinity" }, 5, 1), 5, "unbounded");
  assert.equal(
    envIntInRange("X", { X: "99999999999999999999" }, 5, 1),
    5,
    "past Number.MAX_SAFE_INTEGER",
  );
  assert.equal(envIntInRange("X", { X: "7" }, 5, 1), 7, "usable");
  assert.equal(envIntInRange("X", { X: " 7 " }, 5, 1), 7, "trimmed");
  // A negative is a legitimate value when the floor allows it, so the floor —
  // not the sign — is what rejects.
  assert.equal(envIntInRange("X", { X: "-3" }, 5, -5), -3, "negative above the floor");
});

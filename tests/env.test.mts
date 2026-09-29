import assert from "node:assert/strict";
import test from "node:test";
import { envFlag, envString, envStringStrippedSlash, stripTrailingSlashes } from "../src/lib/env.ts";
import { prodigiApiBase, prodigiApiKey } from "../src/lib/prodigi-config.ts";

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

test("prodigiApiBase strips a trailing slash before the allowlist check", () => {
  assert.equal(
    prodigiApiBase({ PRODIGI_API_BASE: "https://api.sandbox.prodigi.com/" }),
    "https://api.sandbox.prodigi.com",
  );
  assert.throws(
    () => prodigiApiBase({ PRODIGI_API_BASE: "https://evil.example" }),
    /PRODIGI_API_BASE/,
  );
});

test("prodigiApiKey pairs the sandbox host with the sandbox key only", () => {
  withEnv("PRODIGI_SANDBOX_API_KEY", "sbx", () =>
    withEnv("PRODIGI_API_KEY", "live", () => {
      const sandbox = { PRODIGI_API_BASE: "https://api.sandbox.prodigi.com" };
      assert.equal(prodigiApiKey(sandbox), "sbx");
      assert.equal(prodigiApiKey({ ...sandbox, PRODIGI_SANDBOX_API_KEY: "" }), "sbx");
      // Sandbox host with only the live key must not silently use it.
      withEnv("PRODIGI_SANDBOX_API_KEY", undefined, () => {
        assert.throws(
          () => prodigiApiKey({ ...sandbox, PRODIGI_SANDBOX_API_KEY: undefined }),
          /PRODIGI_SANDBOX_API_KEY/,
        );
        // Live host, live key.
        assert.equal(
          prodigiApiKey({ PRODIGI_API_BASE: "https://api.prodigi.com" }),
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

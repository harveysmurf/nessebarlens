import assert from "node:assert/strict";
import test from "node:test";
import { envString, envStringStrippedSlash, stripTrailingSlashes } from "../src/lib/env.ts";
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

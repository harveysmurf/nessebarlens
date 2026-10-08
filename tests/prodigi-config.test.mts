import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PRODIGI_LIVE_API_BASE,
  PRODIGI_SANDBOX_API_BASE,
  classifyProdigiStatus,
  prodigiApiBaseIfAllowed,
  prodigiFailureFrom,
  prodigiKeyConfigured,
  prodigiUrl,
  readProdigiConfig,
} from "../src/lib/prodigi-config.ts";
import { isRetryableProdigiReason } from "../src/lib/prodigi-policy.ts";

/**
 * Every variable prodigi-config reads. Its readers layer the passed env over
 * process.env, so an env of `{}` means "unset" only if the ambient environment
 * does not have them. Without this a developer machine or a CI runner with
 * PRODIGI_API_KEY exported makes "unset" read as configured.
 */
const PRODIGI_KEYS = [
  "PRODIGI_API_BASE",
  "PRODIGI_API_KEY",
  "PRODIGI_SANDBOX_API_KEY",
] as const;

function withCleanEnv<T>(body: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of PRODIGI_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return body();
  } finally {
    for (const key of PRODIGI_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("readProdigiConfig returns the matched base and key for both hosts", () =>
  withCleanEnv(() => {
    assert.deepEqual(
      readProdigiConfig({
        PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
        PRODIGI_SANDBOX_API_KEY: "sbx",
      }),
      { ok: true, base: PRODIGI_SANDBOX_API_BASE, key: "sbx" },
    );
    assert.deepEqual(
      readProdigiConfig({
        PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE,
        PRODIGI_API_KEY: "live",
      }),
      { ok: true, base: PRODIGI_LIVE_API_BASE, key: "live" },
    );
  }));

test("readProdigiConfig reports the three unconfigured ways with one reason", () =>
  withCleanEnv(() => {
    const cases: Array<{ env: Record<string, unknown>; match: RegExp }> = [
      { env: {}, match: /PRODIGI_API_BASE must be/ },
      { env: { PRODIGI_API_BASE: "https://evil.example" }, match: /PRODIGI_API_BASE must be/ },
      { env: { PRODIGI_API_BASE: " " }, match: /PRODIGI_API_BASE must be/ },
      { env: { PRODIGI_API_BASE: 42 }, match: /PRODIGI_API_BASE must be/ },
      {
        env: { PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE },
        match: /PRODIGI_SANDBOX_API_KEY is not set/,
      },
      {
        env: { PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE, PRODIGI_SANDBOX_API_KEY: "" },
        match: /PRODIGI_SANDBOX_API_KEY is not set/,
      },
      {
        env: { PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE },
        match: /PRODIGI_API_KEY is not set/,
      },
    ];
    for (const { env, match } of cases) {
      const result = readProdigiConfig(env);
      assert.equal(result.ok, false, JSON.stringify(env));
      if (result.ok) continue;
      assert.equal(result.kind, "unconfigured", JSON.stringify(env));
      assert.equal(result.reason, "prodigi-unconfigured", JSON.stringify(env));
      assert.equal(result.status, null, JSON.stringify(env));
      assert.match(result.message, match);
    }
  }));

test("a sandbox host with only the live key is not configured", () =>
  withCleanEnv(() => {
    assert.equal(
      readProdigiConfig({
        PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
        PRODIGI_API_KEY: "live",
      }).ok,
      false,
    );
  }));

test("prodigiKeyConfigured and prodigiApiBaseIfAllowed share the one read", () =>
  withCleanEnv(() => {
    assert.equal(prodigiKeyConfigured({}), false);
    assert.equal(
      prodigiKeyConfigured({ PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE }),
      false,
    );
    assert.equal(
      prodigiKeyConfigured({
        PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
        PRODIGI_SANDBOX_API_KEY: "k",
      }),
      true,
    );
    assert.equal(prodigiApiBaseIfAllowed({}), undefined);
    assert.equal(
      prodigiApiBaseIfAllowed({ PRODIGI_API_BASE: "https://evil.example" }),
      undefined,
    );
    assert.equal(
      prodigiApiBaseIfAllowed({
        PRODIGI_API_BASE: `${PRODIGI_SANDBOX_API_BASE}/`,
      }),
      PRODIGI_SANDBOX_API_BASE,
    );
  }));

test("prodigiUrl builds an endpoint from the already-validated base", () => {
  assert.equal(
    prodigiUrl(PRODIGI_SANDBOX_API_BASE, "v4.0/quotes"),
    `${PRODIGI_SANDBOX_API_BASE}/v4.0/quotes`,
  );
  assert.equal(
    prodigiUrl(PRODIGI_LIVE_API_BASE, "v4.0/orders"),
    `${PRODIGI_LIVE_API_BASE}/v4.0/orders`,
  );
});

test("classifyProdigiStatus maps each status to its retry kind and reason", () => {
  assert.deepEqual(classifyProdigiStatus(401), { kind: "server", reason: "prodigi-auth-error" });
  assert.deepEqual(classifyProdigiStatus(403), { kind: "server", reason: "prodigi-auth-error" });
  assert.deepEqual(classifyProdigiStatus(429), { kind: "server", reason: "prodigi-rate-limit" });
  assert.deepEqual(classifyProdigiStatus(500), { kind: "server", reason: "prodigi-unavailable" });
  assert.deepEqual(classifyProdigiStatus(503), { kind: "server", reason: "prodigi-unavailable" });
  assert.deepEqual(classifyProdigiStatus(400), { kind: "client", reason: "prodigi-validation-error" });
  assert.deepEqual(classifyProdigiStatus(422), { kind: "client", reason: "prodigi-validation-error" });
});

test("isRetryableProdigiReason names every retryable reason, and only those", () => {
  for (const reason of [
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-timeout",
    "prodigi-asset-unconfigured",
    "prodigi-unconfigured",
  ]) {
    assert.equal(isRetryableProdigiReason(reason), true, reason);
  }
  assert.equal(isRetryableProdigiReason("prodigi-validation-error"), false);
  assert.equal(isRetryableProdigiReason("prodigi-error"), false);
  assert.equal(isRetryableProdigiReason(null), false);
});

test("prodigiFailureFrom maps kind to code and status in one place", () => {
  const detail = "PRODIGI_SANDBOX_API_KEY is not set";
  const unconfigured = prodigiFailureFrom({
    ok: false,
    kind: "unconfigured",
    reason: "prodigi-unconfigured",
    message: detail,
    status: null,
  });
  assert.deepEqual(unconfigured, {
    code: "prodigi-unconfigured",
    error: "Pricing is temporarily unavailable, please try again.",
    status: 503,
    detail,
  });

  for (const kind of ["timeout", "client", "server"] as const) {
    const failure = prodigiFailureFrom({
      ok: false,
      kind,
      reason: "prodigi-unavailable",
      message: "Prodigi quote HTTP 502",
      status: 502,
    });
    assert.equal(failure.code, "prodigi-unavailable", kind);
    assert.equal(failure.status, 502, kind);
    assert.equal(failure.detail, "Prodigi quote HTTP 502", kind);
  }
});

test("an upstream message that echoes a config string is still a 502, not a 503", () => {
  // #118: classification no longer matches message text, so a Prodigi body that
  // merely contains our config wording cannot be mistaken for our own
  // misconfiguration. The kind is the only signal prodigiFailureFrom reads.
  const failure = prodigiFailureFrom({
    ok: false,
    kind: "server",
    reason: "prodigi-unavailable",
    message: "Prodigi quote HTTP 400: PRODIGI_SANDBOX_API_KEY is not set",
    status: 400,
  });
  assert.equal(failure.code, "prodigi-unavailable");
  assert.equal(failure.status, 502);
});

test("prodigiFailureFrom never puts the internal detail in the customer fields (#107)", () => {
  for (const message of [
    "PRODIGI_API_KEY is not set",
    "Prodigi quote HTTP 429",
    "Prodigi order HTTP 500: {\"detail\":\"invalid key\"}",
  ]) {
    for (const kind of ["unconfigured", "timeout", "client", "server"] as const) {
      const failure = prodigiFailureFrom({
        ok: false,
        kind,
        reason: "prodigi-unavailable",
        message,
        status: kind === "unconfigured" ? null : 502,
      });
      assert.equal(failure.error.includes(failure.detail), false, message);
      assert.equal(failure.code.includes(failure.detail), false, message);
      assert.match(failure.error, /^Pricing is temporarily unavailable/);
    }
  }
});

test("no Prodigi module classifies a failure by matching its message text", () => {
  // The classification moved onto the `kind` of a failed result, so nothing in
  // the Prodigi modules may still compare a message string to a config message.
  // The removed predicate and its status sibling must be gone, and the URL
  // builder must exist in their place.
  const root = path.join(import.meta.dirname, "..", "src", "lib");
  for (const rel of ["prodigi-config.ts", "prodigi-quote.ts", "prodigi-order.ts"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(
      src.includes("isProdigiUnconfigured"),
      false,
      `${rel} still classifies by message text`,
    );
    assert.equal(
      src.includes("prodigiErrorStatus"),
      false,
      `${rel} still maps a message string to a status`,
    );
  }
  const config = fs.readFileSync(path.join(root, "prodigi-config.ts"), "utf8");
  assert.match(config, /export function readProdigiConfig/);
  assert.match(config, /export function prodigiFailureFrom/);
});

test("the two Prodigi routes take their status from prodigiFailureFrom", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const route of ["quote", "checkout"]) {
    const src = fs.readFileSync(
      path.join(root, `src/app/api/${route}/route.ts`),
      "utf8",
    );
    assert.ok(
      src.includes("prodigiFailureFrom("),
      `${route} must take its Prodigi status from prodigi-config`,
    );
    // The routes no longer catch a thrown Prodigi call, so a re-derived
    // message or a hand-rolled 503/502 split would be the old contract back.
    assert.equal(/e instanceof Error \? e\.message :/.test(src), false, route);
    assert.equal(
      /prodigi-unconfigured\s*\?\s*503\s*:\s*502/.test(src),
      false,
      `${route} re-decides the 503/502 split`,
    );
    // The internal detail must reach the log and only the log (#107).
    assert.ok(src.includes("failure.detail"), `${route} must log the detail`);
    assert.equal(/\.\.\.failure\b/.test(src), false, `${route} spreads the failure`);
  }
});

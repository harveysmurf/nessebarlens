/**
 * sync-worker-secrets.sh used to drop a short or missing PRINT_ASSET_HMAC_SECRET
 * without a word, so production deployed green and then answered 503 for every
 * physical checkout (#114). The secret is required in production and optional in
 * preview, and the boundary is worth a behavioural test: nothing in the TypeScript
 * sees this script, and a source grep cannot tell "errors on a short secret" from
 * "errors on anything".
 *
 * The Cloudflare call is stubbed with an npx shim on PATH so the assertions are
 * about the guard, not about the network. These tests run the script in
 * version-only mode, so the stub is not even reached -- the point is that the
 * guard fires before anything is prepared or sent.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, "scripts", "sync-worker-secrets.sh");

const MIN_LENGTH = 32;

function shimDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-secrets-"));
  const shim = path.join(dir, "npx");
  fs.writeFileSync(shim, "#!/usr/bin/env bash\necho 'npx shim called' \nexit 0\n", { mode: 0o755 });
  return dir;
}

function run(
  target: "preview" | "production",
  secret: string | undefined,
  drop?: "token" | "account",
  /** Override the #117 secrets; omitted means "both present and valid". */
  extra?: Record<string, string>,
): { status: number | null; stderr: string; stdout: string } {
  const dir = shimDir();
  const result = spawnSync("bash", [script, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLOUDFLARE_API_TOKEN: drop === "token" ? "" : "test-token",
      CLOUDFLARE_ACCOUNT_ID: drop === "account" ? "" : "test-account",
      STRIPE_SECRET_KEY:
        target === "production" ? "sk_live_test" : "sk_test_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
      PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      // version-only: run the guards, write the JSON, apply nothing. The
      // version-scoped wrangler call is the one thing these must never depend
      // on to prove a guard works.
      SYNC_SCOPE: "version-only",
      SECRETS_OUT: path.join(dir, "secrets.json"),
      ...(secret === undefined
        ? {}
        : { PRINT_ASSET_HMAC_SECRET: secret }),
      ...(extra ?? {
        RESEND_API_KEY: "re_test_key",
        PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
      }),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Same run, but hands back the prepared secrets file so their presence is asserted. */
function runAndReadSecrets(
  target: "preview" | "production",
  extra: Record<string, string> | undefined,
): { status: number | null; secrets: Record<string, string> } {
  const dir = shimDir();
  const out = path.join(dir, "secrets.json");
  const result = spawnSync("bash", [script, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      STRIPE_SECRET_KEY: target === "production" ? "sk_live_test" : "sk_test_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PRINT_ASSET_HMAC_SECRET: valid,
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
      PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      SYNC_SCOPE: "version-only",
      SECRETS_OUT: out,
      ...(extra ?? {}),
    },
  });
  const secrets = fs.existsSync(out)
    ? (JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, string>)
    : {};
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, secrets };
}

const valid = "s".repeat(MIN_LENGTH);

test("production fails when the print-asset HMAC secret is missing", () => {
  const result = run("production", undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRINT_ASSET_HMAC_SECRET/);
});

test("production fails when the print-asset HMAC secret is too short", () => {
  const result = run("production", "s".repeat(MIN_LENGTH - 1));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

test("production syncs when the print-asset HMAC secret is long enough", () => {
  const result = run("production", valid);
  assert.equal(result.status, 0);
});

test("preview warns but does not fail without the secret", () => {
  const result = run("preview", undefined);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning: PRINT_ASSET_HMAC_SECRET/);
});

test("production fails when padding hides a short secret", () => {
  // The two guards must judge the same string: Python strips before measuring,
  // so bash has to strip too. Otherwise 31 real chars + a pasted newline passes
  // bash at "32" and is dropped downstream -- deploy green, checkout 503ing.
  const result = run("production", "s".repeat(MIN_LENGTH - 1) + "\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

test("production accepts a padded secret that is genuinely long enough", () => {
  const result = run("production", `  ${valid}\n`);
  assert.equal(result.status, 0);
});

test("a missing Cloudflare token fails loudly instead of reaching wrangler", () => {
  // This guard was written as `: "${CLOUDFLARE_API_TOKEN:-...}"`, which expands
  // to empty and always succeeds -- so it guarded nothing and a manual run fell
  // through to wrangler's opaque auth error. Asserting the name is the only way
  // a `:?`-shaped regression gets caught; a source grep cannot tell a working
  // guard from a decorative one.
  const result = run("production", valid, "token");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_API_TOKEN/);
});

test("a missing Cloudflare account id fails loudly too", () => {
  const result = run("production", valid, "account");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
});

// --- #117: transactional email + Prodigi callback bearer ------------------
//
// Both ride on the deploying version via --secrets-file. A key missing from
// that file is not "the feature is off": the order flow succeeds and the
// customer gets no confirmation, or the callback route 503s forever. These
// assert both the guard and the presence in the prepared file, because a guard
// that fires while the value is still omitted from the JSON would be a green
// deploy that loses the secret anyway.

test("production fails when RESEND_API_KEY is missing", () => {
  const result = run("production", valid, undefined, { RESEND_API_KEY: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESEND_API_KEY/);
});

test("preview warns but does not fail without RESEND_API_KEY", () => {
  const result = run("preview", valid, undefined, { RESEND_API_KEY: "" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning: RESEND_API_KEY/);
});

test("production fails when PRODIGI_WEBHOOK_TOKEN is missing", () => {
  const result = run("production", valid, undefined, { RESEND_API_KEY: "re_live_key", PRODIGI_WEBHOOK_TOKEN: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRODIGI_WEBHOOK_TOKEN/);
});

test("production rejects a Prodigi webhook token short enough to guess", () => {
  const result = run("production", valid, undefined, { RESEND_API_KEY: "re_live_key", PRODIGI_WEBHOOK_TOKEN: "w".repeat(31) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

test("padding does not smuggle a short webhook token past the length guard", () => {
  const result = run("production", valid, undefined, { RESEND_API_KEY: "re_live_key", PRODIGI_WEBHOOK_TOKEN: "w".repeat(31) + "\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

test("both #117 secrets reach the file the deploying version carries", () => {
  const { status, secrets } = runAndReadSecrets("production", {
    RESEND_API_KEY: "re_live_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(64),
  });
  assert.equal(status, 0);
  assert.equal(secrets.RESEND_API_KEY, "re_live_key");
  assert.equal(secrets.PRODIGI_WEBHOOK_TOKEN, "w".repeat(64));
});

test("a padded Resend key is trimmed, not dropped", () => {
  const { status, secrets } = runAndReadSecrets("production", {
    RESEND_API_KEY: "  re_live_key\n",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
  });
  assert.equal(status, 0);
  assert.equal(secrets.RESEND_API_KEY, "re_live_key");
});

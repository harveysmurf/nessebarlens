/**
 * sync-pages-secrets.sh used to drop a short or missing PRINT_ASSET_HMAC_SECRET
 * without a word, so production deployed green and then answered 503 for every
 * physical checkout (#114). The secret is required in production and optional in
 * preview, and the boundary is worth a behavioural test: nothing in the TypeScript
 * sees this script, and a source grep cannot tell "errors on a short secret" from
 * "errors on anything".
 *
 * The Cloudflare call is stubbed with a python3 shim on PATH so the assertions are
 * about the guard, not about the network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, "scripts", "sync-pages-secrets.sh");

const MIN_LENGTH = 32;

function shimDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-secrets-"));
  const shim = path.join(dir, "python3");
  fs.writeFileSync(shim, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return dir;
}

function run(
  target: "preview" | "production",
  secret: string | undefined,
): { status: number | null; stderr: string; stdout: string } {
  const dir = shimDir();
  const result = spawnSync("bash", [script, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CF_API_TOKEN: "test-token",
      CF_ACCOUNT_ID: "test-account",
      STRIPE_SECRET_KEY:
        target === "production" ? "sk_live_test" : "sk_test_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
      PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      ...(secret === undefined
        ? {}
        : { PRINT_ASSET_HMAC_SECRET: secret }),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
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
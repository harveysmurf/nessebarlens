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
  target: "preview" | "staging" | "production",
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
      // A complete production environment is the baseline; a test that wants one
      // of these absent overrides it with "". That keeps each new required
      // secret from breaking every existing case.
      ...(extra ?? {
        RESEND_API_KEY: "re_test_key",
        PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
        RECONCILE_SECRET: "r".repeat(32),
      }),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Same run, but hands back the prepared secrets file so their presence is asserted. */
function runAndReadSecrets(
  target: "preview" | "staging" | "production",
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
      RESEND_API_KEY: "re_test_key",
      PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
      RECONCILE_SECRET: "r".repeat(32),
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

/**
 * The cutover deployed a Worker whose every secret was present and whose
 * checkout still answered 503 "Checkout is not configured". The cause was here,
 * not in the app: NEXT_PUBLIC_SITE_URL was deliberately excluded from the
 * secrets map, on the reasoning that it "bakes at build". It does -- and
 * `configuredSiteUrl()` also reads it from the runtime environment, which on a
 * Worker is bindings only. So the site quoted prices, passed the secrets guard,
 * passed the smoke test, and could not take a single payment.
 *
 * These are behavioural for the same reason as the print-HMAC ones above: the
 * exclusion lived in a comment, and a source grep cannot tell "shipped" from
 * "documented as intentionally absent".
 */
const SITE_ENV = {
  NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com",
  NEXT_PUBLIC_WEB_IMAGES_BASE: "https://images.nessebarlens.com",
};

/** The #117 keys production also requires, so a run reaches the file at all. */
const WITH_SITE_ENV = { ...SITE_ENV, RESEND_API_KEY: "re_test_key", PRODIGI_WEBHOOK_TOKEN: "w".repeat(32) };

test("production ships NEXT_PUBLIC_SITE_URL to the Worker, not just to the build", () => {
  const { status, secrets } = runAndReadSecrets("production", WITH_SITE_ENV);
  assert.equal(status, 0);
  assert.equal(
    secrets.NEXT_PUBLIC_SITE_URL,
    "https://nessebarlens.com",
    "the runtime read in configuredSiteUrl() comes from this binding; without it /api/checkout is 503",
  );
});

test("production ships NEXT_PUBLIC_WEB_IMAGES_BASE too", () => {
  const { secrets } = runAndReadSecrets("production", WITH_SITE_ENV);
  assert.equal(secrets.NEXT_PUBLIC_WEB_IMAGES_BASE, "https://images.nessebarlens.com");
});

test("an unset NEXT_PUBLIC_SITE_URL is dropped and loudly named, not shipped blank", () => {
  // A blank binding would read as present-but-wrong and hide the real cause
  // behind a URL that resolves nowhere.
  // Explicitly blank, not merely absent: the helper spreads process.env, and a
  // CI runner in the `staging` Environment already has NEXT_PUBLIC_SITE_URL set.
  // Relying on absence made this test pass or fail with the runner's config,
  // which is the opposite of what it is here to pin.
  const { status, secrets } = runAndReadSecrets("production", {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    NEXT_PUBLIC_SITE_URL: "",
    NEXT_PUBLIC_WEB_IMAGES_BASE: "   ",
  });
  assert.equal(status, 0);
  assert.ok(
    !("NEXT_PUBLIC_SITE_URL" in secrets),
    "an empty value must not become a binding",
  );
  assert.equal(secrets.NEXT_PUBLIC_SITE_URL, undefined);
});

test("preview ships the same two, so a preview host can take a sandbox order", () => {
  const { status, secrets } = runAndReadSecrets("preview", SITE_ENV);
  assert.equal(status, 0);
  assert.equal(secrets.NEXT_PUBLIC_SITE_URL, "https://nessebarlens.com");
});

/* --- staging ---------------------------------------------------------------
   A sandbox-keyed target that is as strict as production about the secrets a
   preview may lack: the whole point of staging is to rehearse the full
   purchase, email and callback included. */

test("staging fails without each of the three secrets a preview may skip", () => {
  const ok = { RESEND_API_KEY: "re_test_key", PRODIGI_WEBHOOK_TOKEN: "w".repeat(32) };
  const missingHmac = run("staging", undefined);
  assert.equal(missingHmac.status, 1);
  assert.match(missingHmac.stderr, /staging requires PRINT_ASSET_HMAC_SECRET/);

  const missingResend = run("staging", valid, undefined, { ...ok, RESEND_API_KEY: "" });
  assert.equal(missingResend.status, 1);
  assert.match(missingResend.stderr, /staging requires RESEND_API_KEY/);

  const missingToken = run("staging", valid, undefined, { ...ok, PRODIGI_WEBHOOK_TOKEN: "" });
  assert.equal(missingToken.status, 1);
  assert.match(missingToken.stderr, /staging requires PRODIGI_WEBHOOK_TOKEN/);

  const shortToken = run("staging", valid, undefined, { ...ok, PRODIGI_WEBHOOK_TOKEN: "w".repeat(31) });
  assert.equal(shortToken.status, 1);
  assert.match(shortToken.stderr, /at least 32 characters/);
});

test("staging syncs with all three present and ships them", () => {
  const { status, secrets } = runAndReadSecrets("staging", {
    PRINT_ASSET_HMAC_SECRET: valid,
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
  });
  assert.equal(status, 0);
  assert.equal(secrets.RESEND_API_KEY, "re_test_key");
  assert.equal(secrets.PRODIGI_WEBHOOK_TOKEN, "w".repeat(32));
  assert.equal(secrets.PRINT_ASSET_HMAC_SECRET, valid);
});

test("staging enforces a test-mode Stripe key", () => {
  const dir = shimDir();
  const result = spawnSync("bash", [script, "staging"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      STRIPE_SECRET_KEY: "sk_live_oops",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PRINT_ASSET_HMAC_SECRET: valid,
      RESEND_API_KEY: "re_test_key",
      PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
      PRODIGI_SANDBOX_API_KEY: "sandbox-key",
      SYNC_SCOPE: "version-only",
      SECRETS_OUT: path.join(dir, "secrets.json"),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staging requires a sk_test_/);
});

/**
 * RECONCILE_SECRET was the same bug a second time, and it stayed hidden for
 * longer. The route guards it in the Worker env and returns 503; reconcile.yml
 * guards it in the *cron's* env before calling. Both guards passed, the secret
 * sat unused in the GitHub production Environment, and nothing ever shipped it
 * — so every 15-minute tick answered 503 and the cron had been red since the
 * Workers migration (failing at least from 2026-10-03T16:18Z, before today's
 * cutover).
 *
 * Two guards on two sides of an HTTP call is exactly the arrangement that hides
 * this: neither side can see the other's environment.
 */
const RECONCILE_ENV = { RECONCILE_SECRET: "r".repeat(32) };

test("production ships RECONCILE_SECRET to the Worker", () => {
  const { status, secrets } = runAndReadSecrets("production", {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    ...RECONCILE_ENV,
  });
  assert.equal(status, 0);
  assert.equal(
    secrets.RECONCILE_SECRET,
    "r".repeat(32),
    "without it /api/internal/reconcile answers 503 and the cron fails every tick",
  );
});

test("production refuses to deploy without RECONCILE_SECRET", () => {
  const result = run("production", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "",
  });
  assert.equal(result.status, 1, "a deploy that cannot reconcile must not go green");
  assert.match(result.stderr, /RECONCILE_SECRET/);
});

test("production refuses a RECONCILE_SECRET short enough to guess", () => {
  const result = run("production", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "r".repeat(31),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

test("preview warns about RECONCILE_SECRET rather than failing", () => {
  const result = run("preview", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning: RECONCILE_SECRET/);
});

test("all deploy workflows pass RECONCILE_SECRET to the sync script", () => {
  // The guard above is only reachable if the value reaches the script at all,
  // so the wiring is asserted too — otherwise the new guard hard-fails every
  // deploy with an error that names a secret nobody passed.
  // release.yml carries both deploy targets since #200 merged staging.yml and
  // prod.yml into one ordered pipeline, so one file entry covers what used to
  // be two.
  for (const wf of ["release.yml", "preview.yml"]) {
    const text = fs.readFileSync(path.join(root, ".github", "workflows", wf), "utf8");
    assert.match(
      text,
      /RECONCILE_SECRET: \$\{\{ secrets\.RECONCILE_SECRET \}\}/,
      `${wf} must pass RECONCILE_SECRET`,
    );
  }
});

test("preview warns about RECONCILE_SECRET rather than failing: no cron reaches it", () => {
  // A preview deploy has no cron of any kind pointed at it: the Cloudflare Cron
  // Trigger is declared per environment in wrangler.toml and only production
  // and staging carry one. So a preview without the secret costs nothing, and
  // failing it would block PR previews for a secret they cannot use.
  const result = run("preview", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning: RECONCILE_SECRET/);
});

test("staging refuses to deploy without RECONCILE_SECRET: its cron would 503 every tick", () => {
  // Staging runs the same reconciler as production (wrangler.toml declares
  // [env.staging.triggers] crons), so a staging deploy without the secret
  // deploys a Worker whose only cron answers 503 fifteen minutes at a time --
  // and staging is where that is rehearsable, not on production.
  const result = run("staging", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staging requires RECONCILE_SECRET/);
});

test("staging refuses a RECONCILE_SECRET short enough to guess", () => {
  const result = run("staging", valid, undefined, {
    RESEND_API_KEY: "re_test_key",
    PRODIGI_WEBHOOK_TOKEN: "w".repeat(32),
    RECONCILE_SECRET: "short",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
});

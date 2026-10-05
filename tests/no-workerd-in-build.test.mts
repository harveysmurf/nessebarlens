/**
 * next.config.ts must not boot the local Workers runtime in a build (#227).
 *
 * `initOpenNextCloudflareForDev` exists for `next dev`: it starts wrangler's
 * platform proxy (miniflare -> workerd) and puts the bindings on the process
 * global. next.config.ts is evaluated by every process that builds or serves
 * the app, and `next build` runs its prerender workers with
 * NODE_ENV=production — so an unguarded call makes each build worker boot its
 * own runtime and contend for the same `.wrangler/state` SQLite file. That is
 * the `SQLITE_BUSY: database is locked` that failed `Build (production)` and
 * blocked deploys (#227), and the same signature in the e2e smoke job (#228).
 *
 * The guard is asserted behaviourally rather than by grepping the source: the
 * probe process evaluates the real config with the package stubbed, and the
 * test reads what the stub recorded. A future refactor that moves the call,
 * adds a second one, or widens the condition fails here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const probe = path.join(
  import.meta.dirname,
  "fixtures",
  "next-config-init-probe.mjs",
);

/**
 * Evaluate next.config.ts in a fresh process and return the calls the stubbed
 * `initOpenNextCloudflareForDev` recorded.
 *
 * NODE_ENV and CI are deleted from the inherited environment first, then the
 * case's overrides applied, so a test never silently inherits the very
 * value it is trying to prove absent — the classic way an "unset" assertion
 * passes on a developer's machine and lies in CI.
 */
function evaluateConfig(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "next-config-probe-"));
  const record = path.join(dir, "init.ndjson");
  try {
    const env = {
      ...process.env,
      // The production branch of next.config.ts throws without this, before it
      // ever reaches the init call, which would hide the behaviour under test.
      NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com",
      OPENNEXT_INIT_RECORD: record,
    };
    delete env.NODE_ENV;
    delete env.CI;
    Object.assign(env, overrides);

    const result = spawnSync(process.execPath, [probe], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    const calls = fs.existsSync(record)
      ? fs
          .readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    return { ...result, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a production build does not start the platform proxy", () => {
  const { status, calls, stderr } = evaluateConfig({ NODE_ENV: "production" });
  assert.equal(status, 0, `config did not evaluate: ${stderr}`);
  assert.deepEqual(
    calls,
    [],
    "next build evaluates the config with NODE_ENV=production; calling " +
      "initOpenNextCloudflareForDev there boots workerd on .wrangler/state",
  );
});

test("an env that is merely not production does not start it either", () => {
  // The guard is `=== "development"`, not `!== "production"`. `next test`,
  // tooling, and an unset NODE_ENV all reach the config; none of them is the
  // dev server the bindings are for, and none may boot a runtime.
  for (const override of [{}, { NODE_ENV: "test" }, { NODE_ENV: "" }]) {
    const { calls } = evaluateConfig(override);
    assert.deepEqual(
      calls,
      [],
      `NODE_ENV=${JSON.stringify(override.NODE_ENV)} must not init the proxy`,
    );
  }
});

test("next dev still initialises the bindings", () => {
  const { status, calls, stderr } = evaluateConfig({ NODE_ENV: "development" });
  assert.equal(status, 0, `config did not evaluate: ${stderr}`);
  assert.equal(
    calls.length,
    1,
    "the dev server needs the platform proxy; the guard must not over-correct",
  );
  // A local `next dev` keeps the default persistence, so bindings survive a
  // restart the way a developer expects.
  assert.equal(calls[0].options, null);
});

test("CI next dev uses no on-disk state, so two dev processes cannot race", () => {
  // #228: Playwright's webServer starts one `next dev`, but Next imports the
  // config in more than one process, so without this the two platform proxies
  // share `.wrangler/state` SQLite and can hit SQLITE_BUSY. persist:false makes
  // each proxy's D1/KV/R2 state in-memory. The e2e seed is in-memory Maps
  // (orders-dev-seed.ts), so nothing the smoke flow reads needs to survive.
  const { calls } = evaluateConfig({ NODE_ENV: "development", CI: "true" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { persist: false });
});

test("the guard is written down where the next reader looks", () => {
  const config = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
  assert.match(
    config,
    /process\.env\.NODE_ENV === "development"[\s\S]*?initOpenNextCloudflareForDev\(/,
    "the init call must sit under the development guard, with the reason in a comment",
  );
  assert.match(config, /SQLITE_BUSY/);
});

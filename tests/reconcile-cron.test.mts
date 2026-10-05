/**
 * #201: the Cloudflare Cron Trigger that replaced GitHub's 15-minute schedule.
 *
 * Two halves, and the second is the one that has bitten this repo before: the
 * tick builds the right request, and `wrangler.toml`/`worker.ts` are wired so
 * the request happens at all. A correct `runReconcileCron` with no trigger
 * deployed is the original silent-ignore bug with a test suite next to it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FALLBACK_ORIGIN,
  RECONCILE_PATH,
  RECONCILE_SECRET_HEADER,
  buildReconcileRequest,
  reconcileOrigin,
  runReconcileCron,
  type ReconcileCronContext,
} from "../src/lib/reconcile-cron.ts";

const root = path.join(import.meta.dirname, "..");

const SECRET = "s".repeat(40);

/** A context that records what it was handed instead of waiting on it. */
function recordingContext(): ReconcileCronContext & {
  waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  return { waited, waitUntil: (p) => waited.push(p) };
}

function tickEnv(extra: Record<string, unknown> = {}) {
  return {
    NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com",
    RECONCILE_SECRET: SECRET,
    ...extra,
  };
}

const event = { scheduledTime: 1_700_000_000_000, cron: "*/15 * * * *" };

/** Capture console.error lines so the assertions can read them. */
async function withCapturedErrors<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    const result = await run();
    return { result, logs };
  } finally {
    console.error = real;
  }
}

test("a tick POSTs the reconcile route with the secret header", () => {
  const built = buildReconcileRequest(tickEnv());
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(built.request.method, "POST");
  assert.equal(
    built.request.url,
    `https://nessebarlens.com${RECONCILE_PATH}`,
    "the cron must address the same path and origin GitHub Actions did — a second URL is a second code path",
  );
  assert.equal(built.request.headers.get(RECONCILE_SECRET_HEADER), SECRET);
  assert.equal(
    RECONCILE_PATH,
    "/api/internal/reconcile",
    "the route path is duplicated in DEVELOPMENT.md and reconcile.yml; if it moves, this is where it is pinned",
  );
});

test("the secret is never put in the query string or the log", async () => {
  const built = buildReconcileRequest(tickEnv());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(!built.request.url.includes(SECRET), "a secret in a URL lands in access logs and traces");

  const { logs } = await withCapturedErrors(async () => {
    const response = new Response("nope", { status: 503 });
    await runReconcileCron({
      event,
      env: tickEnv(),
      ctx: recordingContext(),
      fetch: async () => response,
    });
    return null;
  });
  assert.ok(
    logs.join("\n").includes(SECRET) === false,
    "the cron log must not contain RECONCILE_SECRET",
  );
});

test("a missing secret fails the tick instead of calling the route", async () => {
  // A call without the secret gets a 404 by design -- the route hides its own
  // existence from unauthenticated callers. In a log that is indistinguishable
  // from "nothing to reconcile", so the reconciler looks alive while it is dead.
  for (const env of [
    { ...tickEnv(), RECONCILE_SECRET: undefined },
    { ...tickEnv(), RECONCILE_SECRET: "" },
    { ...tickEnv(), RECONCILE_SECRET: "   " },
    { NEXT_PUBLIC_SITE_URL: "https://nessebarlens.com" },
  ]) {
    const built = buildReconcileRequest(env);
    assert.equal(built.ok, false, `expected a refusal for ${JSON.stringify(env.RECONCILE_SECRET)}`);
    if (built.ok) continue;
    assert.match(built.reason, /RECONCILE_SECRET/);

    let called = 0;
    const { result, logs } = await withCapturedErrors(() =>
      runReconcileCron({
        event,
        env,
        ctx: recordingContext(),
        fetch: async () => {
          called += 1;
          return new Response("{}", { status: 200 });
        },
      }).then((r) => r),
    );
    assert.equal(called, 0, "a tick with no secret must not reach the route at all");
    assert.equal(result, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"event":"order.reconcile.cron"/);
    assert.match(logs[0], /"ok":false/);
  }
});

test("the cron and the origin fall back rather than throwing on a bare env", () => {
  // A scheduled event has no request, so there is no host to take the origin
  // from. It must still produce a valid Request: this is the floor under a
  // misconfigured deploy, not the normal path.
  assert.equal(reconcileOrigin({}), FALLBACK_ORIGIN);
  assert.equal(reconcileOrigin({ NEXT_PUBLIC_SITE_URL: "  " }), FALLBACK_ORIGIN);
  assert.equal(reconcileOrigin({ NEXT_PUBLIC_SITE_URL: 42 }), FALLBACK_ORIGIN);
  assert.ok(FALLBACK_ORIGIN.endsWith(".invalid"), "the fallback must not look like a real host");

  assert.equal(
    reconcileOrigin({ NEXT_PUBLIC_SITE_URL: "https://staging.nessebarlens.com///" }),
    "https://staging.nessebarlens.com",
    "a trailing slash would produce https://host//api/internal/reconcile",
  );
});

test("a tick passes the Worker's own env and ctx through to fetch", async () => {
  // The point of calling handler.fetch in-process rather than curling the route:
  // the request runs with the real bindings, so the reconcile path is the one
  // the site serves.
  const env = tickEnv();
  const ctx = recordingContext();
  const seen: { request: Request; env: unknown; ctx: unknown }[] = [];

  await runReconcileCron({
    event,
    env,
    ctx,
    fetch: async (request, passedEnv, passedCtx) => {
      seen.push({ request, env: passedEnv, ctx: passedCtx });
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].env, env);
  assert.equal(seen[0].ctx, ctx);
});

test("a non-2xx is logged, not thrown, so the next tick still runs", async () => {
  const { logs } = await withCapturedErrors(async () => {
    const response = await runReconcileCron({
      event,
      env: tickEnv(),
      ctx: recordingContext(),
      fetch: async () => new Response("boom", { status: 500 }),
    });
    assert.equal(response?.status, 500, "the response is returned so a caller can inspect it");
    return null;
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"status":500/);
  assert.match(logs[0], /"ok":false/);
});

test("a successful tick logs nothing", async () => {
  const { logs } = await withCapturedErrors(async () => {
    await runReconcileCron({
      event,
      env: tickEnv(),
      ctx: recordingContext(),
      fetch: async () => new Response("{}", { status: 200 }),
    });
    return null;
  });
  assert.deepEqual(logs, [], "a green tick every 15 minutes must not fill the log with noise");
});

// --- the deployment wiring, which is where the original bug lived ---

test("wrangler.toml's main is the wrapper, not the generated worker", () => {
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  assert.match(
    toml,
    /^main = "worker\.ts"$/m,
    "pointing main back at .open-next/worker.js would silently drop the scheduled handler while every trigger still validated",
  );
  assert.doesNotMatch(toml, /^main = "\.open-next/m);
});

test("both environments declare a cron trigger", () => {
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const production = toml.slice(0, toml.search(/^\[env\.staging\]\s*$/m));
  const staging = toml.slice(toml.search(/^\[env\.staging\]\s*$/m));

  // Wrangler does not inherit top-level keys into [env.*]: a staging deploy
  // with no [env.staging.triggers] is green and never reconciles, which is the
  // same shape of silent failure #201 filed.
  assert.match(production, /^\[triggers\]\s*$/m, "no top-level [triggers] block");
  assert.match(
    production,
    /^crons = \["\*\/15 \* \* \* \*"\]$/m,
    "production's cron must be every 15 minutes",
  );
  assert.match(staging, /^\[env\.staging\.triggers\]\s*$/m, "staging has no trigger block");
  assert.match(staging, /^crons = \["\*\/15 \* \* \* \*"\]$/m);
});

test("each environment's cron origin is its own host", () => {
  const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const production = toml.slice(0, toml.search(/^\[env\.staging\]\s*$/m));
  const staging = toml.slice(toml.search(/^\[env\.staging\]\s*$/m));

  assert.match(production, /^\[vars\]\s*$/m);
  assert.match(production, /^NEXT_PUBLIC_SITE_URL = "https:\/\/nessebarlens\.com"$/m);
  assert.match(staging, /^\[env\.staging\.vars\]\s*$/m);
  assert.match(
    staging,
    /^NEXT_PUBLIC_SITE_URL = "https:\/\/staging\.nessebarlens\.com"$/m,
    "staging's cron must address staging: a production host here would tick staging's D1 through production's URL, or tick nothing",
  );
});

test("the wrapper re-exports every Durable Object the generated worker exports", () => {
  const generatedPath = path.join(root, ".open-next", "worker.js");
  if (!fs.existsSync(generatedPath)) {
    // Only runs after `opennextjs-cloudflare build`. Skipping is honest here:
    // in a plain checkout `worker.ts` is excluded from typecheck (its only
    // import is a build artifact), and a build in CI is the only place the
    // real file exists.
    return;
  }
  const generated = fs.readFileSync(generatedPath, "utf8");
  const wrapper = fs.readFileSync(path.join(root, "worker.ts"), "utf8");

  const exported = [
    ...generated.matchAll(/^export \{ (\w+) \} from/gm),
  ].map((m) => m[1]);

  assert.ok(exported.length >= 3, `expected the DO classes in the generated worker, found ${JSON.stringify(exported)}`);
  for (const name of exported) {
    assert.match(
      wrapper,
      new RegExp(`\\b${name}\\b`),
      `${name} is exported by the generated worker but not re-exported by worker.ts — the Durable Object would stop existing on deploy`,
    );
  }
});

test("the wrapper's fetch is the generated fetch, not a reimplementation", () => {
  const wrapper = fs.readFileSync(path.join(root, "worker.ts"), "utf8");
  assert.match(wrapper, /import handler from "\.\/\.open-next\/worker\.js"/);
  assert.match(
    wrapper,
    /fetch: handler\.fetch/,
    "the request path must stay the generated one; wrapping it in a new handler would duplicate Next's asset and middleware routing",
  );
  assert.match(wrapper, /scheduled\(/);
  assert.match(wrapper, /catch \(e\)/, "an unhandled rejection in scheduled() surfaces only in the dashboard");
});

test("reconcile.yml is dispatch-only, with the cron owned by the Worker", () => {
  const reconcile = fs.readFileSync(
    path.join(root, ".github", "workflows", "reconcile.yml"),
    "utf8",
  );
  assert.doesNotMatch(
    reconcile,
    /^\s*schedule:/m,
    "leaving the GitHub schedule in place means two reconcilers run against the same orders, and the silent GitHub one masks a broken Worker cron",
  );
  assert.match(reconcile, /workflow_dispatch/);
});
/**
 * Cloudflare Cron Trigger shim for the reconciler (#201).
 *
 * GitHub Actions schedules are best-effort: reconcile.yml asked for every 15
 * minutes and GitHub actually ran it about 11 times in 42 hours, so the real
 * bound on recovery from a lost webhook or a Prodigi order that never called
 * back was hours, not 15 minutes. Cron Triggers are delivered by the platform that runs
 * the code, so the schedule cannot be silently dropped the same way.
 *
 * The reconciler itself stays a Next route. This module builds the request
 * `.github/workflows/reconcile.yml` makes on dispatch -- same path, same method,
 * same `x-reconcile-secret` header -- and hands it to the Worker's own `fetch`,
 * so there is one code path with one auth check and one implementation to
 * reason about, rather than a second reconciler written against D1 directly.
 *
 * It lives here rather than in `worker.ts` because `worker.ts` imports
 * `.open-next/worker.js`, which only exists after `opennextjs-cloudflare build`.
 * A test cannot import that; it can import this.
 */

/** Path of the route that does the work. One definition, used by both crons. */
export const RECONCILE_PATH = "/api/internal/reconcile";

/** Header the route reads. Unchanged from the GitHub cron (#116/#133). */
export const RECONCILE_SECRET_HEADER = "x-reconcile-secret";

/**
 * Origin used when the Worker env carries no site URL.
 *
 * The request never leaves the process -- `handler.fetch` is called
 * in-process, not over the network -- so this hostname is never resolved and
 * never reaches a third party. It only has to be a syntactically valid origin
 * for `new Request`. `wrangler.toml` sets `NEXT_PUBLIC_SITE_URL` as a var so
 * the real value is used; this is the floor under a misconfigured deploy, and
 * it must not look like a real host, because a fake-looking one in a log is
 * easier to spot than a plausible one.
 */
export const FALLBACK_ORIGIN = "https://reconcile-cron.invalid";

import { stripTrailingSlashes } from "../../domain/pricing/url-patterns";

/** What a cron tick needs from the Worker env. */
export type ReconcileCronEnv = {
  NEXT_PUBLIC_SITE_URL?: unknown;
  RECONCILE_SECRET?: unknown;
};

/** `scheduled()`'s event, narrowed to what this uses. */
export type ScheduledEvent = {
  scheduledTime: number;
  cron: string;
};

/** The bits of `ExecutionContext` this module needs. */
export type ReconcileCronContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * Not named `envString`: that name is how `tests/config-reads-env.test.mts`
 * finds a `process.env` reader on the AST, and this helper reads its argument,
 * never the environment. Reusing the name would add a module to that
 * allowlist's failure output for no reason.
 */
function presentString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The origin to address. `NEXT_PUBLIC_SITE_URL` as a Worker *var* rather than
 * the build-time inlined constant: the inlined value is not readable from the
 * env object, and an env object without it is the case that would otherwise
 * need a guess.
 */
export function reconcileOrigin(env: ReconcileCronEnv): string {
  const configured = presentString(env.NEXT_PUBLIC_SITE_URL);
  if (!configured) return FALLBACK_ORIGIN;
  return stripTrailingSlashes(configured);
}

/**
 * Build the request a cron tick makes, or return why it cannot.
 *
 * Fails closed on a missing secret: calling the route without one would get a
 * 404 (the route hides its own existence from unauthenticated callers), which
 * looks identical to "nothing to reconcile" in a log while the reconciler is in
 * fact dead. A cron tick that cannot authenticate should say so loudly.
 */
export function buildReconcileRequest(
  env: ReconcileCronEnv,
): { ok: true; request: Request } | { ok: false; reason: string } {
  const secret = presentString(env.RECONCILE_SECRET);
  if (!secret) {
    return {
      ok: false,
      reason:
        "RECONCILE_SECRET is missing or empty in the Worker env; /api/internal/reconcile would answer 503 and no order would ever be recovered",
    };
  }
  return {
    ok: true,
    request: new Request(`${reconcileOrigin(env)}${RECONCILE_PATH}`, {
      method: "POST",
      headers: { [RECONCILE_SECRET_HEADER]: secret },
    }),
  };
}

export type ReconcileCronFetch = (
  request: Request,
  env: unknown,
  ctx: ReconcileCronContext,
) => Promise<Response>;

/**
 * Run one tick.
 *
 * Returns the response so the caller can await it (tests, and a future
 * `scheduled()` that wants the outcome); a cron trigger ignores the return
 * value and only cares that the promise settles without throwing.
 *
 * A non-2xx is logged as an error and not thrown. A Cron Trigger that throws
 * surfaces in the dashboard's Cron Events, which is not an alerting path we
 * own -- and the reconciler is best-effort by nature: a failed tick must not
 * stop the next one, and `reconcileOrders` has its own per-order handling.
 */
export async function runReconcileCron(args: {
  event: ScheduledEvent;
  env: ReconcileCronEnv;
  ctx: ReconcileCronContext;
  fetch: ReconcileCronFetch;
}): Promise<Response | undefined> {
  const { event, env, ctx, fetch } = args;
  const built = buildReconcileRequest(env);

  if (!built.ok) {
    console.error(
      JSON.stringify({
        event: "order.reconcile.cron",
        cron: event.cron,
        ok: false,
        reason: built.reason,
      }),
    );
    return undefined;
  }

  const response = await fetch(built.request, env, ctx);
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "order.reconcile.cron",
        cron: event.cron,
        ok: false,
        status: response.status,
      }),
    );
  }
  return response;
}
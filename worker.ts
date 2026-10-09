/**
 * Cloudflare Worker entry (#201).
 *
 * OpenNext's generated `.open-next/worker.js` exports only `default { fetch }`
 * plus the Durable Object classes, so a `[triggers] crons` entry would be
 * accepted by wrangler and then silently never fire. Rather than patch the
 * adapter's output, this wraps it: same `fetch`, same DO classes, plus the
 * `scheduled` handler. `wrangler.toml`'s `main` points here.
 *
 * `opennextjs-cloudflare` reads `main` from `wrangler.toml` and never rewrites
 * it, and `wrangler deploy` bundles whatever `main` names, so the generated
 * file is imported rather than reimplemented.
 */

// `.open-next/worker.js` is a build artifact, so it has no types in a checkout
// and `tsconfig.json` excludes this file: a relative `declare module` cannot
// stand in for an unresolved relative specifier, and `next build` type-checks
// before OpenNext generates the file. `tsc --noEmit` therefore does not cover
// this wrapper; its wiring is pinned by tests/reconcile-cron.test.mts, and the
// cron logic it delegates to (src/infrastructure/cloudflare/reconcile-cron.ts) is fully typechecked.
import handler from "./.open-next/worker.js";

import {
  runReconcileCron,
  type ReconcileCronContext,
  type ScheduledEvent,
} from "./src/infrastructure/cloudflare/reconcile-cron";

export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "./.open-next/worker.js";

const worker = {
  fetch: handler.fetch,

  /**
   * Cloudflare Cron Trigger. Wrapped in try/catch on purpose: an unhandled
   * rejection here shows up only in the dashboard's Cron Events, and a
   * reconciler that stops running is the failure #201 exists to prevent.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Record<string, unknown>,
    ctx: ReconcileCronContext,
  ): Promise<void> {
    try {
      await runReconcileCron({
        event,
        env,
        ctx,
        fetch: handler.fetch as unknown as (
          request: Request,
          env: unknown,
          ctx: ReconcileCronContext,
        ) => Promise<Response>,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "order.reconcile.cron",
          cron: event.cron,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  },
};

export default worker;

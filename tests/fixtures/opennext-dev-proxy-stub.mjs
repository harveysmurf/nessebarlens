/**
 * Stand-in for `@opennextjs/cloudflare` used by next-config-init-probe.mjs.
 *
 * `initOpenNextCloudflareForDev` is the call that boots the local Workers
 * runtime (wrangler's getPlatformProxy -> miniflare -> workerd). The real one
 * is asynchronous and silent from the config's point of view, so the only way
 * to observe from a test whether next.config.ts called it is to record the
 * call. Each invocation appends one JSON line: the arguments it was given, or
 * `null` when it was called with none.
 */

import { appendFileSync } from "node:fs";

export function initOpenNextCloudflareForDev(options) {
  appendFileSync(
    process.env.OPENNEXT_INIT_RECORD,
    `${JSON.stringify({ options: options ?? null })}\n`,
  );
  return Promise.resolve();
}

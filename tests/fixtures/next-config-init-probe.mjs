/**
 * Evaluates the real next.config.ts once, with `@opennextjs/cloudflare`
 * stubbed, so a test can observe whether it tried to start the local Workers
 * runtime. Run as a fresh process because the guard reads NODE_ENV at module
 * evaluation, and because the stub hook has to be registered before the import.
 *
 * Two hooks, and both are load-bearing now:
 *
 *   - `opennext-dev-proxy-hook.mjs` points the package at a recording stub.
 *   - `scripts/resolve-hooks.mjs` resolves the repo's extensionless relative
 *     imports. next.config.ts imports `src/infrastructure/seo/security-headers`,
 *     which bare `node` cannot resolve without it — Next bundles the config and
 *     would not notice. Registering the repo's own resolver rather than bending
 *     the import to an explicit `.ts` keeps the config written in the same style
 *     as the rest of the tree, and means the next config import does not break
 *     this probe.
 */

import { register } from "node:module";

register(new URL("./opennext-dev-proxy-hook.mjs", import.meta.url));
register(new URL("../../scripts/resolve-hooks.mjs", import.meta.url));

await import(new URL("../../next.config.ts", import.meta.url));
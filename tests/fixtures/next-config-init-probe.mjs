/**
 * Evaluates the real next.config.ts once, with `@opennextjs/cloudflare`
 * stubbed, so a test can observe whether it tried to start the local Workers
 * runtime. Run as a fresh process because the guard reads NODE_ENV at module
 * evaluation, and because the stub hook has to be registered before the import.
 */

import { register } from "node:module";

register(new URL("./opennext-dev-proxy-hook.mjs", import.meta.url));

await import(new URL("../../next.config.ts", import.meta.url));

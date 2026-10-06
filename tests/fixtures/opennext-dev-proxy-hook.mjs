/**
 * Resolve hook that points `@opennextjs/cloudflare` at the recording stub.
 *
 * next.config.ts has to import the real package to call it, so the probe
 * process registers this hook first: every later resolve of the bare specifier
 * is short-circuited to tests/fixtures/opennext-dev-proxy-stub.mjs. Nothing
 * else resolves differently, so the config is otherwise the one that ships.
 */

const STUB = new URL("./opennext-dev-proxy-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opennextjs/cloudflare") {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

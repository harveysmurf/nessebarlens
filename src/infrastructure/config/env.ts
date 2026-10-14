/**
 * Worker bindings win over process.env: on Cloudflare the real env only
 * exists in the async context, and process.env is the local/Node fallback.
 * Every reader uses this precedence so a key can never be read from one
 * source in the signer and the other source in the verifier.
 */

import { stripTrailingSlashes } from "../../domain/pricing/url-patterns";

/** A plain string-keyed bag: what `process.env` is, and what tests hand in. */
type StringEnv = Readonly<Record<string, unknown>>;

/**
 * The env a reader may actually see.
 *
 * `CloudflareEnv` is generated from `wrangler.toml` and declares every binding
 * as required, which is what the platform promises once a deploy is live. It is
 * not what a *reader* gets: `wrangler.toml` declaring a bucket is not the
 * platform having bound it, and `readWorkerBindings` has always had to cope with
 * an env that is empty, partial, or entirely absent. So the local declaration
 * goes and the generated global is used, made optional per key here.
 *
 * Deliberately no index signature. Adding one would restore
 * `env.ORDER_DB === undefined` compiling, which is the bug #387 exists to
 * remove; names outside `wrangler.toml` are reached by name through the readers
 * below, never by property access.
 *
 * This is the half of #387 that typing cannot do. Declaring `ORDERS_DB` removes
 * the typo class of bug -- `env.ORDER_DB` stops compiling -- but the absent
 * class is a runtime fact, which is why `isOrdersDatabase` and friends stay.
 */
export type PartialCloudflareEnv = {
  readonly [K in keyof CloudflareEnv]?: CloudflareEnv[K];
};

/**
 * The port every reader takes, and the boundary where precision stops.
 *
 * This is a union rather than one record type because the generated
 * `CloudflareEnv` is an *interface*, and an interface gets no implicit index
 * signature — so `CloudflareEnv` is not assignable to `Record<string, unknown>`,
 * and a single string-keyed parameter type would reject every Worker env while
 * still accepting every `process.env`. Both branches really are read here:
 * `readWorkerBindings` passes the Worker env, and `next dev` and the tests pass
 * process.env or a fixture.
 *
 * The `StringEnv` branch is not only for `process.env`. It also covers the two
 * things the generated interface cannot describe: secrets, which `wrangler types`
 * does not emit (a secret's presence in `wrangler.toml` would be the whole
 * secret — those keys are read by name here and materialised once into
 * `WorkerBindings`), and the deliberately-wrong-shaped values the binding guards
 * exist to reject, which `worker-bindings.ts`'s injection seam is handed on
 * purpose.
 */
export type EnvReader = CloudflareEnv | StringEnv;

/**
 * The one place a name is turned into a value.
 *
 * The union's `CloudflareEnv` branch declares six bindings and no index
 * signature, so indexing it by an arbitrary name is what needs saying out loud;
 * the cast is the boundary between "an env with known keys" and "a lookup by
 * name", which is exactly what every caller of a reader is doing. The `in` test
 * first, so an absent key is `undefined` rather than a prototype hit.
 *
 * Exported for the one caller that must not fall back to `process.env`: the cron
 * entry point, where an absent `NEXT_PUBLIC_SITE_URL` has to mean
 * FALLBACK_ORIGIN rather than silently becoming a local value.
 */
export function envValue(name: string, env: EnvReader): unknown {
  return name in env ? (env as StringEnv)[name] : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

// The ?? against process.env is intentional, not redundant: with the default
// arg it reads the same source twice, which is harmless, and it keeps the
// Worker-env-first precedence correct for callers that pass an env record.
export function envString(
  name: string,
  env: EnvReader = process.env,
): string | undefined {
  return trimmed(envValue(name, env)) ?? trimmed(process.env[name]);
}

/**
 * A boolean env var that defaults to OFF and must be opted into.
 *
 * Only the exact strings "true" and "1" (any case, trimmed) enable it. This
 * is deliberately stricter than envString's truthiness, because the callers
 * are gates around things that 404 rather than things that merely degrade:
 * reading "yes"/"on"/"enabled" as false fails visibly and immediately, while
 * guessing wrong on the way to true breaks a live storefront silently.
 */
export function envFlag(
  name: string,
  env: EnvReader = process.env,
): boolean {
  const value = envString(name, env);
  return value !== undefined && /^(?:true|1)$/i.test(value);
}

/**
 * An integer env var with a default, clamped to `min` and above.
 *
 * For policy knobs rather than credentials: unset, non-numeric, zero and
 * negative all fall back to the default instead of throwing, because these
 * configure limits (download count, token lifetime) and a malformed value must
 * degrade to the documented behaviour rather than break a paid path.
 */
export function envIntInRange(
  name: string,
  env: EnvReader = process.env,
  fallback: number,
  min: number,
): number {
  const value = envString(name, env);
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function envStringStrippedSlash(
  name: string,
  env: EnvReader = process.env,
): string | undefined {
  const value = envString(name, env);
  if (value === undefined) return undefined;
  const stripped = stripTrailingSlashes(value);
  return stripped.length > 0 ? stripped : undefined;
}

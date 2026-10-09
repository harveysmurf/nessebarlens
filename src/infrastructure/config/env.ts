/**
 * Worker bindings win over process.env: on Cloudflare the real env only
 * exists in the async context, and process.env is the local/Node fallback.
 * Every reader uses this precedence so a key can never be read from one
 * source in the signer and the other source in the verifier.
 */

import { stripTrailingSlashes } from "../../domain/pricing/url-patterns";

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
  env: Record<string, unknown> = process.env,
): string | undefined {
  return trimmed(env[name]) ?? trimmed(process.env[name]);
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
  env: Record<string, unknown> = process.env,
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
  env: Record<string, unknown> = process.env,
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
  env: Record<string, unknown> = process.env,
): string | undefined {
  const value = envString(name, env);
  if (value === undefined) return undefined;
  const stripped = stripTrailingSlashes(value);
  return stripped.length > 0 ? stripped : undefined;
}

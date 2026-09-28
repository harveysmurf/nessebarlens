/**
 * Worker bindings win over process.env: on Cloudflare the real env only
 * exists in the async context, and process.env is the local/Node fallback.
 * Every reader uses this precedence so a key can never be read from one
 * source in the signer and the other source in the verifier.
 */

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

/** Strips every trailing slash, so callers can concatenate "/path" safely. */
export function envStringStrippedSlash(
  name: string,
  env: Record<string, unknown> = process.env,
): string | undefined {
  const value = envString(name, env);
  if (value === undefined) return undefined;
  const stripped = value.replace(/\/+$/, "");
  return stripped.length > 0 ? stripped : undefined;
}

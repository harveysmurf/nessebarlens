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

export function envString(
  name: string,
  env: Record<string, unknown> = process.env,
): string | undefined {
  return trimmed(env[name]) ?? trimmed(process.env[name]);
}

export function envStringStrippedSlash(
  name: string,
  env: Record<string, unknown> = process.env,
): string | undefined {
  const value = envString(name, env);
  if (value === undefined) return undefined;
  const stripped = value.replace(/\/$/, "");
  return stripped.length > 0 ? stripped : undefined;
}

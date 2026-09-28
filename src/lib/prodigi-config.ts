import { envString, envStringStrippedSlash } from "./env";

export const PRODIGI_SANDBOX_API_BASE = "https://api.sandbox.prodigi.com";
export const PRODIGI_LIVE_API_BASE = "https://api.prodigi.com";

const ALLOWED_BASES = new Set([
  PRODIGI_SANDBOX_API_BASE,
  PRODIGI_LIVE_API_BASE,
]);

/**
 * Explicit Prodigi API host. Must be set per environment — never inferred
 * from which API key is present.
 */
export function prodigiApiBase(
  env: Record<string, unknown> = process.env,
): string {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  if (!base || !ALLOWED_BASES.has(base)) {
    throw new Error(
      "PRODIGI_API_BASE must be https://api.sandbox.prodigi.com or https://api.prodigi.com",
    );
  }
  return base;
}

export function isProdigiSandboxBase(base: string): boolean {
  return base === PRODIGI_SANDBOX_API_BASE;
}

/** API key paired to the explicit base — sandbox key for sandbox host, live for live. */
export function prodigiApiKey(
  env: Record<string, unknown> = process.env,
): string {
  const base = prodigiApiBase(env);
  if (isProdigiSandboxBase(base)) {
    const key = envString("PRODIGI_SANDBOX_API_KEY", env);
    if (!key) {
      throw new Error("PRODIGI_SANDBOX_API_KEY is not set");
    }
    return key;
  }
  const key = envString("PRODIGI_API_KEY", env);
  if (!key) {
    throw new Error("PRODIGI_API_KEY is not set");
  }
  return key;
}

/**
 * True when a message from the Prodigi layer means "this deployment has no API
 * key", as opposed to Prodigi itself failing. The route handlers turn one into
 * 503 and the other into 502, and matching on the words "API key" never fired:
 * the thrown message is "<NAME>_API_KEY is not set".
 */
export function isProdigiUnconfigured(message: string): boolean {
  return /_API_KEY is not set/.test(message);
}

export function prodigiQuotesUrl(
  env: Record<string, unknown> = process.env,
): string {
  return `${prodigiApiBase(env)}/v4.0/quotes`;
}

export function prodigiOrdersUrl(
  env: Record<string, unknown> = process.env,
): string {
  return `${prodigiApiBase(env)}/v4.0/orders`;
}

export function prodigiKeyConfigured(
  env: Record<string, unknown> = process.env,
): boolean {
  try {
    prodigiApiKey(env);
    return true;
  } catch {
    return false;
  }
}

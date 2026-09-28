export const PRODIGI_SANDBOX_API_BASE = "https://api.sandbox.prodigi.com";
export const PRODIGI_LIVE_API_BASE = "https://api.prodigi.com";

const ALLOWED_BASES = new Set([
  PRODIGI_SANDBOX_API_BASE,
  PRODIGI_LIVE_API_BASE,
]);

function nonempty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Explicit Prodigi API host. Must be set per environment — never inferred
 * from which API key is present.
 */
export function prodigiApiBase(
  env: Record<string, unknown> = process.env,
): string {
  const base =
    nonempty(env.PRODIGI_API_BASE) ?? nonempty(process.env.PRODIGI_API_BASE);
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
    const key =
      nonempty(env.PRODIGI_SANDBOX_API_KEY) ??
      nonempty(process.env.PRODIGI_SANDBOX_API_KEY);
    if (!key) {
      throw new Error("PRODIGI_SANDBOX_API_KEY is not set");
    }
    return key;
  }
  const key =
    nonempty(env.PRODIGI_API_KEY) ?? nonempty(process.env.PRODIGI_API_KEY);
  if (!key) {
    throw new Error("PRODIGI_API_KEY is not set");
  }
  return key;
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

import { envString, envStringStrippedSlash } from "./env";

export const PRODIGI_SANDBOX_API_BASE = "https://api.sandbox.prodigi.com";
export const PRODIGI_LIVE_API_BASE = "https://api.prodigi.com";

const ALLOWED_BASES = new Set([
  PRODIGI_SANDBOX_API_BASE,
  PRODIGI_LIVE_API_BASE,
]);

/**
 * The unconfigured-message grammar, written once.
 *
 * These strings used to be produced at the throw sites and re-derived as a
 * regex by isProdigiUnconfigured, so the classification depended on a second
 * copy of the wording staying in step with the first. Rewording a throw site
 * to "PRODIGI_API_KEY is missing" would have turned a 503 into a 502 -- a
 * deployment problem reported as Prodigi being unhealthy, which is the exact
 * misdiagnosis the predicate exists to prevent. The throw sites and the
 * predicate now build both halves from these functions, so the copies cannot
 * drift. tests/prodigi-config.test.mts checks that everything this module can
 * throw is still classified, which is what catches a *new* throw site.
 *
 * Indexed rather than a name-to-slot map: the first name is the sandbox key
 * for the sandbox host, the second the live key for the live host.
 */
const UNCONFIGURED_KEY_NAMES = [
  "PRODIGI_SANDBOX_API_KEY",
  "PRODIGI_API_KEY",
] as const;

/**
 * The Prodigi shipping method we quote with and buy with.
 *
 * It appeared as a literal in the quote body, the order body and the
 * request type. That is not a cosmetic duplication: if the two drift, the
 * shipping the customer was quoted is not the shipping the order gets, and
 * nothing downstream compares them. One constant, typed from itself, so the
 * type and both payloads cannot disagree.
 */
export const PRODIGI_SHIPPING_METHOD = "Budget";

function missingKeyMessage(name: string): string {
  return `${name} is not set`;
}

function badBaseMessage(): string {
  return `PRODIGI_API_BASE must be ${PRODIGI_SANDBOX_API_BASE} or ${PRODIGI_LIVE_API_BASE}`;
}

/**
 * Explicit Prodigi API host. Must be set per environment — never inferred
 * from which API key is present.
 */
export function prodigiApiBase(
  env: Record<string, unknown> = process.env,
): string {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  if (!base || !ALLOWED_BASES.has(base)) {
    throw new Error(badBaseMessage());
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
  const name = isProdigiSandboxBase(base)
    ? UNCONFIGURED_KEY_NAMES[0]
    : UNCONFIGURED_KEY_NAMES[1];
  const key = envString(name, env);
  if (!key) {
    throw new Error(missingKeyMessage(name));
  }
  return key;
}

/**
 * True when a message from the Prodigi layer means "this deployment is not
 * configured", as opposed to Prodigi itself failing. The route handlers turn
 * one into 503 and the other into 502.
 *
 * Three ways to be unconfigured, and the predicate has to cover all of them:
 *   - PRODIGI_SANDBOX_API_KEY / PRODIGI_API_KEY missing → "<NAME>_API_KEY is not set"
 *   - PRODIGI_API_BASE unset or not an allowlisted host → "PRODIGI_API_BASE must be ..."
 *
 * The base case used to fall through to 502, which is the one status that
 * means "something upstream is unhealthy": a human reading the logs would go
 * look at Prodigi's status page for a misconfigured deploy of ours. Same
 * failure shape as the webhook's catch-all, one layer over.
 *
 * Matching on the message rather than an error subclass is deliberate. The
 * value crosses a bundler, and a module duplicated across two chunks yields
 * two copies of a class that fail an instanceof check -- which would turn a
 * 503 back into the 502 this predicate exists to prevent. Exact equality also
 * means a Prodigi error that merely contains these words cannot be mistaken
 * for ours; the old regex would have matched inside one.
 */
export function isProdigiUnconfigured(message: string): boolean {
  return (
    UNCONFIGURED_KEY_NAMES.some((name) => message === missingKeyMessage(name)) ||
    message === badBaseMessage()
  );
}

/**
 * The status a failed Prodigi call reports: 503 for a misconfigured deploy of
 * ours, 502 for Prodigi being unhealthy.
 *
 * Both API routes decided this with the same one-liner over the same
 * predicate. The *predicate* was already single-sourced, so this is a
 * judgement worth making once rather than a bug fix -- but the value it
 * returns is the difference between "check the deploy" and "check Prodigi's
 * status page", and it was the operator who had to know which one a given
 * 502 was.
 */
export function prodigiErrorStatus(message: string): 502 | 503 {
  return isProdigiUnconfigured(message) ? 503 : 502;
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

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
 * The throw sites and the predicate must build both halves from these
 * functions. If a throw site were reworded to "PRODIGI_API_KEY is missing"
 * the classification would not follow it, turning a 503 into a 502 -- a
 * deployment problem reported as Prodigi being unhealthy, which is the exact
 * misdiagnosis the predicate exists to prevent, and the copies could drift.
 * tests/prodigi-config.test.mts checks that everything this module can
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
 * The one string in a Prodigi error body worth showing a human.
 *
 * Prodigi reports errors in one of `detail`, `message` or `error` depending on
 * the endpoint, and as a JSON object or a bare string depending on the layer
 * that rejected it. All four shapes are read; anything else contributes
 * nothing, because the point is to add the upstream reason when there is one,
 * not to guess at a body we do not understand.
 *
 * Bounded and whitespace-collapsed: this string ends up in a log line and in
 * the JSON body the route hands an unauthenticated caller, and an unbounded
 * upstream payload pasted into either is its own problem.
 *
 * Lives here, not in prodigi-quote, because both Prodigi callers need it and
 * the order path needed it badly enough to have grown its own throwaway parse
 * first (see #135). One reader, so the two failure messages cannot drift.
 */
const DETAIL_LIMIT = 200;

function truncateDetail(value: string): string | null {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.length > DETAIL_LIMIT
    ? `${collapsed.slice(0, DETAIL_LIMIT)}…`
    : collapsed;
}

function prodigiDetail(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed === "string") return truncateDetail(parsed);
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ["detail", "message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return truncateDetail(value);
  }
  return null;
}

/** The upstream reason appended to a Prodigi status message, or "" when there is none. */
export function detailSuffix(raw: string): string {
  const detail = prodigiDetail(raw);
  return detail ? `: ${detail}` : "";
}

/**
 * How long each Prodigi call may take before we give up on it (#104).
 *
 * Without a bound, a hung Prodigi connection hangs our request with it: the
 * customer's spinner never resolves, and the Stripe webhook can outrun Stripe's
 * response window, which makes Stripe mark the delivery failed and pile up
 * concurrent fulfilment attempts for one paid session.
 *
 * Two numbers because two different deadlines apply. The quote is on a customer
 * spinner, so 8s is what a person will wait before the page shows an error. The
 * order is inside the webhook, so it gets the longer 15s and must still finish
 * inside Stripe's window — a timeout there is stored retryable and answered 5xx,
 * so a redelivery places the order rather than losing it.
 *
 * Kept here rather than at each call site because the two values are a pair:
 * the order timeout has to exceed the quote timeout by enough to still be the
 * longer deadline, and two literals in two modules is how that stops being true.
 */
export const PRODIGI_QUOTE_TIMEOUT_MS = 8_000;
export const PRODIGI_ORDER_TIMEOUT_MS = 15_000;

/**
 * The abort signal for a Prodigi call, and the one way to recognise that a call
 * ended because we gave up on it rather than because Prodigi answered.
 *
 * `AbortSignal.timeout` rather than a manual `AbortController` plus
 * `setTimeout`: it has no timer to keep a request-scoped event loop alive, and
 * it aborts on its own if nobody awaits the promise.
 *
 * Detection is by the signal's own `aborted` flag rather than by the error's
 * name or class. `AbortSignal.timeout` aborts with a `TimeoutError` DOMException,
 * but the error that reaches our `catch` is the *fetch's* rejection — which
 * varies by runtime and by whether the request had already been sent. Asking
 * the signal is the one question whose answer does not depend on which.
 */
export function prodigiTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** True when a Prodigi call was ended by our own timeout rather than by Prodigi. */
export function isProdigiTimeout(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  // The signal is the authority above; this covers the runtime that rejects
  // with a TimeoutError without marking the signal — a defensive second
  // reading, not the primary one, so an unrelated failure cannot match it.
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "TimeoutError"
  );
}

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
 *
 * Every reader here takes its env as a required argument and never falls back
 * to process.env, so this module is a pure function of what it is handed and
 * the only place a Prodigi value reaches process.env is config.ts. A default
 * parameter would be a back door around exactly the invariant the AST guard
 * checks (#119): a call with no argument would read an env var from a module
 * the AC says must not read env, and a test passing `{}` would silently read
 * the real process environment instead.
 */
export function prodigiApiBase(
  env: Record<string, unknown>,
): string {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  if (!base || !ALLOWED_BASES.has(base)) {
    throw new Error(badBaseMessage());
  }
  return base;
}

/**
 * The allowlisted base, or undefined when unset or not an allowed host. Never
 * throws, so config.ts can report it without risking an error above a route's
 * try.
 *
 * The non-throwing twin of prodigiApiBase, sharing its ALLOWED_BASES, so the
 * two cannot disagree about what "configured" means. Without it the config
 * summary would have to re-implement the allowlist, and a deployment pointing
 * at the wrong host would read as fully configured until the first request,
 * which is the opposite of the one-clear-error the summary exists to produce.
 */
export function prodigiApiBaseIfAllowed(
  env: Record<string, unknown>,
): string | undefined {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  return base && ALLOWED_BASES.has(base) ? base : undefined;
}

function isProdigiSandboxBase(base: string): boolean {
  return base === PRODIGI_SANDBOX_API_BASE;
}

/** API key paired to the explicit base — sandbox key for sandbox host, live for live. */
export function prodigiApiKey(
  env: Record<string, unknown>,
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
 * An unconfigured deployment must never fall through to 502, which is the one
 * status that means "something upstream is unhealthy": a human reading the logs
 * would go look at Prodigi's status page for a misconfigured deploy of ours.
 * Same failure shape as the webhook's catch-all, one layer over.
 *
 * Matching on the message rather than an error subclass is deliberate. The
 * value crosses a bundler, and a module duplicated across two chunks yields
 * two copies of a class that fail an instanceof check -- which would turn a
 * 503 back into the 502 this predicate exists to prevent. Exact equality also
 * means a Prodigi error that merely contains these words cannot be mistaken
 * for ours; a substring regex would match inside one.
 */
export function isProdigiUnconfigured(message: string): boolean {
  return (
    UNCONFIGURED_KEY_NAMES.some(
      (name) => message === missingKeyMessage(name),
    ) || message === badBaseMessage()
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

/**
 * What a failed Prodigi call reports when the throw was not an Error. Both
 * routes quote Prodigi, so one wording is right for both callers today; a third
 * caller with a different failure to describe gets its own response, not a
 * parameter here.
 */
const QUOTE_FAILED_MESSAGE = "Quote failed";

/**
 * The machine-readable half of a failed Prodigi call.
 *
 * `prodigi-unconfigured` is this deployment missing something (503) and
 * `prodigi-unavailable` is Prodigi itself failing (502) — the same split
 * prodigiErrorStatus already draws, in a form a client can branch on without
 * parsing prose.
 */
export type ProdigiFailureCode = "prodigi-unconfigured" | "prodigi-unavailable";

/**
 * What the customer reads, per code. Deliberately one sentence that says
 * nothing about our configuration or Prodigi's: both routes are unauthenticated
 * endpoints, so "PRODIGI_API_KEY is not set" or "Prodigi quote HTTP 429" told
 * an unauthenticated caller our deploy state and our upstream's behaviour for
 * free (#107).
 */
const CUSTOMER_MESSAGE = "Pricing is temporarily unavailable, please try again.";

/** What a caller has to put in a failed Prodigi response, minus next/server. */
export type ProdigiFailure = {
  /** The stable code to put in the response body. */
  code: ProdigiFailureCode;
  /** The customer-safe message to put in the response body. */
  error: string;
  status: 502 | 503;
  /**
   * The full internal message — env var names, upstream status text — for the
   * server log only. Never serialized: a route that spreads the whole failure
   * into its JSON body leaks the detail back, so the two halves are separate
   * fields and a route has to name `detail` to log it.
   */
  detail: string;
};

/**
 * The envelope both Prodigi routes hand back from their catch block: unwrap the
 * message, classify it with prodigiErrorStatus, and pair that with the
 * customer-safe code and copy. One module owns all of it, so a reworded
 * fallback ("Could not reach Prodigi"), a changed classification rule or a new
 * code cannot land in one route only.
 *
 * Stays free of `next/server` for the same reason json-body.ts does: the caller
 * owns the NextResponse, so this is unit testable as a plain function.
 */
export function prodigiFailure(e: unknown): ProdigiFailure {
  const detail = e instanceof Error ? e.message : QUOTE_FAILED_MESSAGE;
  const code: ProdigiFailureCode = isProdigiUnconfigured(detail)
    ? "prodigi-unconfigured"
    : "prodigi-unavailable";
  return {
    code,
    error: CUSTOMER_MESSAGE,
    status: prodigiErrorStatus(detail),
    detail,
  };
}

export function prodigiQuotesUrl(
  env: Record<string, unknown>,
): string {
  return `${prodigiApiBase(env)}/v4.0/quotes`;
}

export function prodigiOrdersUrl(
  env: Record<string, unknown>,
): string {
  return `${prodigiApiBase(env)}/v4.0/orders`;
}

export function prodigiKeyConfigured(
  env: Record<string, unknown>,
): boolean {
  try {
    prodigiApiKey(env);
    return true;
  } catch {
    return false;
  }
}

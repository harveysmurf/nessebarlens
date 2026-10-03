import { envString, envStringStrippedSlash } from "./env";

export const PRODIGI_SANDBOX_API_BASE = "https://api.sandbox.prodigi.com";
export const PRODIGI_LIVE_API_BASE = "https://api.prodigi.com";

const ALLOWED_BASES = new Set([
  PRODIGI_SANDBOX_API_BASE,
  PRODIGI_LIVE_API_BASE,
]);

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
 * The two key names, indexed by host: the first is the sandbox key for the
 * sandbox host, the second the live key for the live host. Indexed rather than
 * a name-to-slot map so the key never gets sniffed from what happens to be set.
 */
const UNCONFIGURED_KEY_NAMES = [
  "PRODIGI_SANDBOX_API_KEY",
  "PRODIGI_API_KEY",
] as const;

/**
 * Why a Prodigi call could not be made or completed.
 *
 * The retry decision (`kind`) and the diagnosis (`reason`) are deliberately
 * separate axes. Auth and rate-limit failures share the same *retry* behaviour
 * but are different operational problems, so they get different reasons — the
 * stored record has to say which one it was, or "prodigi-error" tells nobody
 * whether to rotate a key or back off.
 */
export type ProdigiFailureReason =
  /** 401/403 — our key is wrong, revoked, or pointed at the wrong host. */
  | "prodigi-auth-error"
  /** 429 — we are being throttled; retrying later is correct. */
  | "prodigi-rate-limit"
  /** 5xx — Prodigi is down or erroring. */
  | "prodigi-unavailable"
  /**
   * Prodigi accepted the connection and then went quiet past our deadline
   * (#104). Distinct from prodigi-unavailable because the answer differs: an
   * unreachable Prodigi is worth retrying later, whereas a timeout may mean the
   * order was created and the response lost — which is exactly what the
   * idempotency key on sessionId is for, so a redelivery is safe and is the
   * only way the customer gets their print.
   */
  | "prodigi-timeout"
  /** 4xx that is our fault and will never succeed on retry (bad request body). */
  | "prodigi-validation-error"
  /** 2xx with no order id in the body — a contract change, not a status code. */
  | "prodigi-error"
  /**
   * We hold paid money but cannot sign the master URL, so there is no asset to
   * send. Distinct from prodigi-unavailable: Prodigi was never contacted.
   */
  | "prodigi-asset-unconfigured"
  /**
   * This deployment has no usable Prodigi API key, or PRODIGI_API_BASE is not
   * an allowed host. Prodigi was never contacted. Retryable: the key is
   * deployment config, and a redeploy inside Stripe's redelivery window
   * (~3 days) is enough to place the order.
   */
  | "prodigi-unconfigured";

/**
 * How a failed Prodigi call is retried. The value is the failure's own shape,
 * not a name the caller matches against a message string.
 *
 * "server", "timeout" and "unconfigured" are all retryable and are answered 5xx
 * by the webhook; "client" is a permanent failure answered 200. "unconfigured"
 * and "timeout" are separated from "server" so a config problem and a deadline
 * are diagnosable at a glance instead of all collapsing into "Prodigi is down".
 */
export type ProdigiFailureKind =
  | "unconfigured"
  | "timeout"
  | "client"
  | "server";

/**
 * One result type for every Prodigi caller.
 *
 * Both the quote path and the order path return this, so a failure from either
 * carries the same `kind`/`reason`/`message`/`status` shape and a route can
 * answer one way without reading a thrown message back out of an Error.
 */
export type ProdigiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: ProdigiFailureKind;
      reason: ProdigiFailureReason;
      message: string;
      status: number | null;
    };

/** The failed arm of `ProdigiResult`, the input a route hands to prodigiFailureFrom. */
export type ProdigiFailureBranch = Extract<ProdigiResult<never>, { ok: false }>;

/**
 * A Prodigi configuration read that found the deployment unconfigured.
 *
 * `reason` is the stable "prodigi-unconfigured" code the retry decision and the
 * stored record understand; `message` is the same internal wording the throwing
 * readers produced ("<NAME>_API_KEY is not set", "PRODIGI_API_BASE must be …"),
 * kept as a log detail and never a classification key (#118).
 */
export type ProdigiUnconfiguredFailure = {
  ok: false;
  kind: "unconfigured";
  reason: "prodigi-unconfigured";
  message: string;
  status: null;
};

export type ProdigiConfigResult =
  | { ok: true; base: string; key: string }
  | ProdigiUnconfiguredFailure;

/**
 * Read the Prodigi host and its paired key as one tagged result.
 *
 * The host and the key are read together because they are a matched pair: the
 * sandbox key serves the sandbox host and the live key the live host, and the
 * key name is chosen from the base rather than sniffed. A deployment is
 * unconfigured in exactly three ways — `PRODIGI_API_BASE` unset or not one of
 * the two allowlisted hosts, or the key for the chosen host unset — and all
 * three come back as the same `unconfigured` failure with a message that names
 * the missing variable, for the log.
 *
 * Every reader here takes its env as a required argument and never falls back
 * to process.env, so this module is a pure function of what it is handed and
 * the only place a Prodigi value reaches process.env is config.ts (#119).
 */
export function readProdigiConfig(
  env: Record<string, unknown>,
): ProdigiConfigResult {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  if (!base || !ALLOWED_BASES.has(base)) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: "prodigi-unconfigured",
      message: badBaseMessage(),
      status: null,
    };
  }
  const name = isProdigiSandboxBase(base)
    ? UNCONFIGURED_KEY_NAMES[0]
    : UNCONFIGURED_KEY_NAMES[1];
  const key = envString(name, env);
  if (!key) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: "prodigi-unconfigured",
      message: missingKeyMessage(name),
      status: null,
    };
  }
  return { ok: true, base, key };
}

function isProdigiSandboxBase(base: string): boolean {
  return base === PRODIGI_SANDBOX_API_BASE;
}

/**
 * The allowlisted base, or undefined when unset or not an allowed host. Never
 * throws, so config.ts can report it without risking an error above a route's
 * try. Shares readProdigiConfig's allowlist, so the two cannot disagree about
 * what "configured" means.
 */
export function prodigiApiBaseIfAllowed(
  env: Record<string, unknown>,
): string | undefined {
  const base = envStringStrippedSlash("PRODIGI_API_BASE", env);
  return base && ALLOWED_BASES.has(base) ? base : undefined;
}

/**
 * True when this deployment has a usable Prodigi host/key pair. Reimplemented
 * on readProdigiConfig so "configured" has one definition; it never throws.
 */
export function prodigiKeyConfigured(env: Record<string, unknown>): boolean {
  return readProdigiConfig(env).ok;
}

/**
 * Build a Prodigi URL from an already-validated base.
 *
 * The base is the value readProdigiConfig returned (trailing slash already
 * stripped), so this never needs to re-validate or throw: the caller has
 * already failed closed on an unconfigured read before it can reach here.
 */
export function prodigiUrl(base: string, path: string): string {
  return `${base}/${path}`;
}

/**
 * Map a Prodigi HTTP status to retry behaviour plus a diagnosable reason.
 *
 * Exported for the tests that pin the mapping; it is the whole policy in one
 * place, so "which statuses are terminal" has exactly one answer.
 */
export function classifyProdigiStatus(status: number): {
  kind: "client" | "server";
  reason: ProdigiFailureReason;
} {
  if (status === 401 || status === 403) {
    return { kind: "server", reason: "prodigi-auth-error" };
  }
  if (status === 429) {
    return { kind: "server", reason: "prodigi-rate-limit" };
  }
  if (status >= 500) {
    return { kind: "server", reason: "prodigi-unavailable" };
  }
  return { kind: "client", reason: "prodigi-validation-error" };
}

/**
 * Failures we still intend to retry, so the stored order stays eligible for a
 * redelivery instead of being short-circuited as a duplicate.
 */
const RETRYABLE_PRODIGI_REASONS: ReadonlySet<ProdigiFailureReason> =
  new Set<ProdigiFailureReason>([
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-timeout",
    "prodigi-asset-unconfigured",
    "prodigi-unconfigured",
  ]);

export function isRetryableProdigiReason(
  reason: string | null,
): reason is ProdigiFailureReason {
  return (
    reason !== null &&
    RETRYABLE_PRODIGI_REASONS.has(reason as ProdigiFailureReason)
  );
}

/**
 * The machine-readable half of a failed Prodigi call.
 *
 * `prodigi-unconfigured` is this deployment missing something (503) and
 * `prodigi-unavailable` is Prodigi itself failing (502) — the same split the
 * kind→status mapping draws, in a form a client can branch on without parsing
 * prose.
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
 * The envelope both Prodigi routes hand back from a failed result. The kind is
 * the one signal that decides the code and status: an unconfigured deployment
 * is our fault (503), and a timeout, a client error or a server error are all
 * Prodigi being unreachable (502) — with the same customer-safe copy either
 * way, so nothing observable changes for the caller.
 *
 * Stays free of `next/server` for the same reason json-body.ts does: the caller
 * owns the NextResponse, so this is unit testable as a plain function.
 */
export function prodigiFailureFrom(
  result: ProdigiFailureBranch,
): ProdigiFailure {
  if (result.kind === "unconfigured") {
    return {
      code: "prodigi-unconfigured",
      error: CUSTOMER_MESSAGE,
      status: 503,
      detail: result.message,
    };
  }
  return {
    code: "prodigi-unavailable",
    error: CUSTOMER_MESSAGE,
    status: 502,
    detail: result.message,
  };
}

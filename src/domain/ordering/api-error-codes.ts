/**
 * The browser-facing failure codes of the quote and checkout endpoints.
 *
 * These are what the endpoints answer with, and they are deliberately not
 * sentences: the sentence for a code lives in the dictionary and is rendered
 * by the client, in the reader's language.
 *
 * The set is closed. A failure mode that is not in it has no sentence in any
 * dictionary, so adding one is a change in three places — here, in the
 * dictionary, and in the tests — and never a new string in a route. That is
 * what keeps the routes free of prose: a route decides *which* failure it is,
 * and the copy for it is the reader's business.
 *
 * They say nothing about our deployment. "unconfigured" and "unavailable" are
 * words a customer can be shown; the env var and the vendor's status text
 * are words only the log gets (#107).
 */
export const API_ERROR_CODES = {
  /** The body was not the shape the endpoint accepts. */
  invalidRequest: "invalid-request",
  /** The photograph named in the body is not in the catalog. */
  unknownPhoto: "unknown-photo",
  /** The chosen print option is not offered for this photograph. */
  optionUnavailable: "option-unavailable",
  /** The price could not be obtained. */
  pricingUnavailable: "pricing-unavailable",
  /** The checkout session could not be created. */
  checkoutUnavailable: "checkout-unavailable",
  /** The feature is not deployed in this environment. */
  serviceUnconfigured: "service-unconfigured",
} as const;

/** One of the codes the endpoints answer with. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** The codes as plain strings, for the guard that reads an untrusted body. */
const API_ERROR_CODE_VALUES: readonly string[] = Object.values(API_ERROR_CODES);

/**
 * Whether a value from the wire is one of this set's codes.
 *
 * A runtime guard, because the body arrives from the network: a code is only
 * a code if it is one of ours, and the copy for it exists only if it is.
 */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODE_VALUES.includes(value);
}

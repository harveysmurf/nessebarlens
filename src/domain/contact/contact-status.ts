/**
 * The contact attempt statuses, in the domain.
 *
 * They are the closed set the analytics dataset is keyed by: the second blob
 * of a `contact` row is the status of the attempt, and the report queries it
 * by exact string. Nothing typed that vocabulary before — the writer took a
 * bare `string`, the route spelled `malformed` and `unconfigured` beside the
 * call, and the submit path spelled the rest as outcome kinds.
 *
 * With no owner, the two halves can drift: a status spelled one way in the
 * route and another in the submit path produces two dataset values for one
 * outcome, and the report's grouping shows an attempt in a bucket nobody
 * queried. The writer also accepted any string at all, so a typo in one of
 * those spellings would have been written to the dataset and read back by
 * nobody.
 *
 * The values did not move: the dataset keeps the strings it already has.
 */

/** The status of one contact attempt, as written to the dataset. */
export const CONTACT_ATTEMPT_STATUSES = {
  /** The body was not JSON, or not the shape the contact form sends. */
  malformed: "malformed",
  /** No verifier, no recipient or no mail key: the feature is not deployed. */
  unconfigured: "unconfigured",
  /** The message was accepted and sent. */
  ok: "ok",
  /** The visitor's own fields failed the contact rule. */
  invalid: "invalid",
  /** Too many attempts from this address. */
  rateLimited: "rate-limited",
  /** Turnstile refused the submission. */
  rejected: "rejected",
  /** The message was accepted but the mail provider would not take it. */
  deliveryFailed: "delivery-failed",
} as const;

export type ContactAttemptStatus =
  (typeof CONTACT_ATTEMPT_STATUSES)[keyof typeof CONTACT_ATTEMPT_STATUSES];

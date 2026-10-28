import {
  CONTACT_ATTEMPT_STATUSES,
  type ContactAttemptStatus,
} from "./contact-status";

/**
 * The field-level codes of the contact form.
 *
 * A field error is a code, not a sentence: the form renders it next to the
 * field, and the sentence for it lives in the dictionary, in the reader's
 * language. The codes are closed, so every one of them has a sentence in every
 * locale, and a field error that is not one of them is not shown at all.
 */
export const CONTACT_FIELD_ERROR_CODES = {
  /** No name was typed. */
  nameRequired: "name-required",
  /** The name is longer than the form allows. */
  nameTooLong: "name-too-long",
  /** No address was typed. */
  emailRequired: "email-required",
  /** The address is longer than the form allows. */
  emailTooLong: "email-too-long",
  /** The address is not shaped like an address. */
  emailInvalid: "email-invalid",
  /** No message was typed. */
  messageRequired: "message-required",
  /** The message is longer than the form allows. */
  messageTooLong: "message-too-long",
  /** The anti-spam challenge was not completed. */
  turnstileRequired: "turnstile-required",
} as const;

/** One of the field-level codes. */
export type ContactFieldErrorCode =
  (typeof CONTACT_FIELD_ERROR_CODES)[keyof typeof CONTACT_FIELD_ERROR_CODES];

/**
 * The codes of a failed contact attempt.
 *
 * They are the attempt statuses, minus the one that is not a failure. The
 * analytics dataset is keyed by those statuses and the report groups by them,
 * so the code a browser reads and the status the dataset holds are the same
 * string: one spelling, and no way for the two to drift.
 */
export type ContactErrorCode = Exclude<
  ContactAttemptStatus,
  typeof CONTACT_ATTEMPT_STATUSES.ok
>;

/** The field codes as plain strings, for the guard that reads a body. */
const CONTACT_FIELD_ERROR_CODE_VALUES: readonly string[] =
  Object.values(CONTACT_FIELD_ERROR_CODES);

/** The attempt statuses that are failures, as plain strings. */
const CONTACT_ERROR_CODE_VALUES: readonly string[] = Object.values(
  CONTACT_ATTEMPT_STATUSES,
).filter((status) => status !== CONTACT_ATTEMPT_STATUSES.ok);

/** Whether a value from the wire is one of the field-level codes. */
export function isContactFieldErrorCode(
  value: unknown,
): value is ContactFieldErrorCode {
  return (
    typeof value === "string" &&
    CONTACT_FIELD_ERROR_CODE_VALUES.includes(value)
  );
}

/** Whether a value from the wire is one of the attempt-failure codes. */
export function isContactErrorCode(value: unknown): value is ContactErrorCode {
  return (
    typeof value === "string" && CONTACT_ERROR_CODE_VALUES.includes(value)
  );
}

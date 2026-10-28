/**
 * Contact-form message (#293).
 *
 * The visitor's submission is described here as plain data and validated by
 * pure code, so the same rules can run on the server without a DOM and the
 * client can mirror them for instant feedback. Nothing in this module reads the
 * environment, the network or the request — a route validates and then hands the
 * value to an application port.
 *
 * The field errors are codes, not copy: the form renders the sentence the
 * dictionary holds for the code, next to the field, and the route echoes the
 * codes in its 400 body. A sentence written here would be a sentence in one
 * language, shown to every reader of the form.
 */

import { isRecord } from "../json/record";
import {
  CONTACT_FIELD_ERROR_CODES,
  isContactFieldErrorCode,
  type ContactFieldErrorCode,
} from "./contact-error-codes";

/** Bounds the form enforces. Policy, not credentials — safe to share. */
export const CONTACT_NAME_MAX = 100;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_MESSAGE_MAX = 5_000;

/** The fields a submission carries, in the order the form shows them. */
const CONTACT_FIELDS = [
  "name",
  "email",
  "message",
  "turnstileToken",
] as const;

/** One of the form's fields. */
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** The fields as plain strings, for the guard that reads a body. */
const CONTACT_FIELD_VALUES: readonly string[] = CONTACT_FIELDS;

/** Whether a value from the wire is one of the form's fields. */
export function isContactField(value: unknown): value is ContactField {
  return typeof value === "string" && CONTACT_FIELD_VALUES.includes(value);
}

/** A single field's rejection: which input, and what went wrong with it. */
export type ContactFieldError = {
  field: ContactField;
  code: ContactFieldErrorCode;
};

/**
 * A validated submission. `turnstileToken` is the widget's token; it is
 * single-use and short-lived, and is carried here only as far as the verifier.
 */
export type ContactMessage = {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
};

export type ContactParseResult =
  | { ok: true; value: ContactMessage }
  | { ok: false; errors: ContactFieldError[] };

/**
 * Deliberately permissive: one `@`, a dot in the domain, no whitespace. This is
 * not RFC 5322 — the only authority on whether an address exists is the mail
 * provider, and a stricter parser would reject valid addresses the owner could
 * have replied to. Length is checked separately against CONTACT_EMAIL_MAX.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email-format rule, exposed so the client can mirror it exactly.
 *
 * It answers with a code rather than a sentence: the rule is shared by the
 * server and the client, and the words for it belong to the reader's
 * language, not to this module.
 */
export function contactEmailError(email: string): ContactFieldErrorCode | null {
  if (email.length === 0) return CONTACT_FIELD_ERROR_CODES.emailRequired;
  if (email.length > CONTACT_EMAIL_MAX) {
    return CONTACT_FIELD_ERROR_CODES.emailTooLong;
  }
  if (!EMAIL_PATTERN.test(email)) {
    return CONTACT_FIELD_ERROR_CODES.emailInvalid;
  }
  return null;
}

/**
 * Validate an untrusted request body into a ContactMessage, or collect the
 * fields that failed. Every field is checked so the visitor sees all problems
 * at once rather than one per round-trip. A non-object body yields the same
 * "missing" errors as an empty one.
 */
export function parseContactMessage(raw: unknown): ContactParseResult {
  const record = isRecord(raw) ? raw : {};

  const name = trimmedString(record.name);
  const email = trimmedString(record.email);
  const message = trimmedString(record.message);
  const turnstileToken = trimmedString(record.turnstileToken);

  const errors: ContactFieldError[] = [];

  if (name === null || name.length === 0) {
    errors.push({
      field: "name",
      code: CONTACT_FIELD_ERROR_CODES.nameRequired,
    });
  } else if (name.length > CONTACT_NAME_MAX) {
    errors.push({
      field: "name",
      code: CONTACT_FIELD_ERROR_CODES.nameTooLong,
    });
  }

  // An absent address is the empty address: the reader owns that wording, so
  // the code a missing field gets is the code an empty field gets.
  const emailError = contactEmailError(email ?? "");
  if (emailError !== null) {
    errors.push({ field: "email", code: emailError });
  }

  if (message === null || message.length === 0) {
    errors.push({
      field: "message",
      code: CONTACT_FIELD_ERROR_CODES.messageRequired,
    });
  } else if (message.length > CONTACT_MESSAGE_MAX) {
    errors.push({
      field: "message",
      code: CONTACT_FIELD_ERROR_CODES.messageTooLong,
    });
  }

  if (turnstileToken === null || turnstileToken.length === 0) {
    errors.push({
      field: "turnstileToken",
      code: CONTACT_FIELD_ERROR_CODES.turnstileRequired,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    // Non-null because every branch that leaves a field null pushes an error.
    value: {
      name: name as string,
      email: email as string,
      message: message as string,
      turnstileToken: turnstileToken as string,
    },
  };
}

/**
 * The field errors a failed response reports.
 *
 * The body arrives from the network, so it is read as unknown: an entry is
 * kept only when both its field and its code are ones we know. A code the
 * dictionary has no sentence for would render as an empty line under the
 * field, which is worse than no line at all — so it is dropped, and the
 * generic message above the form is what the visitor reads.
 */
export function readContactFieldErrors(value: unknown): ContactFieldError[] {
  if (!isRecord(value)) return [];
  const fields = value.fields;
  if (!Array.isArray(fields)) return [];
  const errors: ContactFieldError[] = [];
  for (const entry of fields) {
    if (!isRecord(entry)) continue;
    const field = entry.field;
    const code = entry.code;
    if (!isContactField(field) || !isContactFieldErrorCode(code)) continue;
    errors.push({ field, code });
  }
  return errors;
}

/**
 * Build the owner-facing email from a validated message. The visitor's address
 * rides as the reply-to (set by the sender adapter), so a reply reaches them
 * directly, and their message is the body after a short header of the facts.
 */
export function buildContactEmail(message: ContactMessage): {
  subject: string;
  text: string;
} {
  // Collapse any newlines out of the name so it cannot forge extra header-like
  // lines in the subject. The message body is left exactly as typed.
  const name = message.name.replace(/[\r\n]+/g, " ");
  const text = [
    "New message from the Nessebar Lens contact form.",
    "",
    `Name: ${name}`,
    `Email: ${message.email}`,
    "",
    message.message,
    "",
    "— Nessebar Lens website",
  ].join("\n");
  return { subject: `Website contact from ${name}`, text };
}

/** Trimmed string, or null for anything that is not a string. */
function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

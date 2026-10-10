/**
 * Contact-form message (#293).
 *
 * The visitor's submission is described here as plain data and validated by
 * pure code, so the same rules can run on the server without a DOM and the
 * client can mirror them for instant feedback. Nothing in this module reads the
 * environment, the network or the request — a route validates and then hands the
 * value to an application port.
 *
 * The field errors are user-facing copy, not codes: the form renders them
 * verbatim next to the field, and the route echoes them in its 400 body. Keep
 * them short, plain and free of anything about our internals.
 */

/** Bounds the form enforces. Policy, not credentials — safe to share. */
export const CONTACT_NAME_MAX = 100;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_MESSAGE_MAX = 5_000;

export type ContactField = "name" | "email" | "message" | "turnstileToken";

/** A single field's rejection: which input and what to show the visitor. */
export type ContactFieldError = {
  field: ContactField;
  message: string;
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

/** The email-format rule, exposed so the client can mirror it exactly. */
export function contactEmailError(email: string): string | null {
  if (email.length === 0) return "Please enter your email address.";
  if (email.length > CONTACT_EMAIL_MAX) return "That email address is too long.";
  if (!EMAIL_PATTERN.test(email)) return "Please enter a valid email address.";
  return null;
}

/**
 * Validate an untrusted request body into a ContactMessage, or collect the
 * fields that failed. Every field is checked so the visitor sees all problems
 * at once rather than one per round-trip. A non-object body yields the same
 * "missing" errors as an empty one.
 */
export function parseContactMessage(raw: unknown): ContactParseResult {
  const record =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const name = trimmedString(record.name);
  const email = trimmedString(record.email);
  const message = trimmedString(record.message);
  const turnstileToken = trimmedString(record.turnstileToken);

  const errors: ContactFieldError[] = [];

  if (name === null || name.length === 0) {
    errors.push({ field: "name", message: "Please enter your name." });
  } else if (name.length > CONTACT_NAME_MAX) {
    errors.push({ field: "name", message: "That name is too long." });
  }

  const emailError =
    email === null ? "Please enter your email address." : contactEmailError(email);
  if (emailError !== null) {
    errors.push({ field: "email", message: emailError });
  }

  if (message === null || message.length === 0) {
    errors.push({ field: "message", message: "Please enter a message." });
  } else if (message.length > CONTACT_MESSAGE_MAX) {
    errors.push({ field: "message", message: "That message is too long." });
  }

  if (turnstileToken === null || turnstileToken.length === 0) {
    errors.push({
      field: "turnstileToken",
      message: "Please complete the anti-spam check.",
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

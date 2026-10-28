import { isRecord } from "../json/record";

/**
 * The one shape every browser-facing API failure has.
 *
 * The endpoints answer with a code and nothing else. A sentence written by the
 * server is a sentence in the server's language, and an endpoint cannot know
 * the reader's — that was the bug this replaces: a contact form that told a
 * Bulgarian visitor what a Turnstile check was in English. A code is a name.
 * The copy for a code lives in the dictionary, and the client resolves it
 * there, in the page's language.
 *
 * The set of codes is closed per endpoint, so a code the client does not know
 * is a code from a newer deploy, and it is not shown: the client falls back
 * to the generic sentence. "Something we do not recognise" is a worse thing to
 * show a customer than "please try again".
 */
export type ErrorCodeSet<T extends string> = {
  /** Whether a value from the wire is one of this set's codes. */
  isCode: (value: unknown) => value is T;
  /** The copy for each code, in the reader's language. */
  copy: Readonly<Record<T, string>>;
};

/**
 * The code a failure body carries, or null when it carries none.
 *
 * The body is read as unknown: it came from the network, so it is whatever
 * the edge, a proxy or a deploy in front of us sent. An empty string is not a
 * code either — it is a body that says nothing.
 */
export function failureCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const code = value.code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * The copy for the failure a body reports.
 *
 * `generic` is the sentence for a failure that cannot be named: a body that
 * is not JSON, a code this bundle does not know, a code nobody wrote. The
 * customer's next move is the same in every one of those cases, so the same
 * sentence serves them all.
 */
export function failureCopy<T extends string>(
  value: unknown,
  set: ErrorCodeSet<T>,
  generic: string,
): string {
  const code = failureCode(value);
  if (code === null || !set.isCode(code)) return generic;
  return set.copy[code];
}

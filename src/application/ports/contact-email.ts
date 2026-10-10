/**
 * Contact-email port (#293).
 *
 * A contact-form notification is a different shape from the order emails in
 * `domain/ordering/email.ts`: it has no customer and no `EmailKind`, it goes to
 * the studio owner, and the visitor's address is the reply-to. Keeping a
 * dedicated port avoids widening the order sender's `EmailKind` union with a
 * value the order record's `emailsSent` parser would then have to know about.
 *
 * `send` reports failure as a result, never a throw, so the route can answer a
 * controlled 5xx when Resend is down rather than leaking the vendor error.
 * `message` is diagnostic only and is logged, never returned to the visitor.
 */

export type ContactEmail = {
  /** The visitor's address, set as the message's reply-to. */
  replyTo: string;
  subject: string;
  text: string;
};

export interface ContactEmailSender {
  send(mail: ContactEmail): Promise<{ ok: boolean; message: string }>;
}

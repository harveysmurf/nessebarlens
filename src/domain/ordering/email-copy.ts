/**
 * Plain-text customer email copy (#117).
 *
 * Imitates print-copy.ts: the words live here, keyed off EmailKind, so a new
 * kind is a compile error until someone writes the subject and body. Plain
 * text only — no HTML, and never a master key, an asset URL, or a Prodigi id.
 * Those are internal; a customer who sees them would only be confused or
 * exposed to a credential that is not theirs to hold.
 *
 * The digital confirmation links the success page (`siteUrl` + session path),
 * not a download token minted in this request. Minting a token inside an email
 * builder would couple copy to the store and would let a re-send mint a second
 * credential; the success page already knows how to hand over the link.
 */

import { EMAIL_KINDS, type EmailKind } from "./email";
import { orderReference } from "./order-reference";

export type EmailCopyInput = {
  kind: EmailKind;
  sessionId: string;
  /** Absolute origin, no trailing slash — same contract as siteUrl(). */
  siteUrl: string;
  /** Tracking number for print-shipped; ignored by other kinds. */
  trackingNumber?: string | undefined;
  /** Carrier name for print-shipped; ignored by other kinds. */
  carrier?: string | undefined;
  /** Tracking URL for print-shipped; ignored by other kinds. */
  trackingUrl?: string | undefined;
};

export type EmailCopy = {
  subject: string;
  text: string;
};

/**
 * The signature every email from the studio closes with.
 *
 * It was written out four times — once in each of the three customer emails and
 * once in the operator alert — so a rebrand was a four-place edit, and the first
 * edit to miss one would have signed half the studio's mail differently. Owned
 * here rather than in the alerts adapter because this is where the studio's
 * wording lives; `email-operator-alerts.ts` already imports the Resend constants
 * from its sibling in `domain/ordering/`.
 */
export const STUDIO_SIGNATURE = "— Nessebar Lens";

/**
 * The line that tells a customer which order the mail is about.
 *
 * `orderReference` is the derivation, and it is already shared with the success
 * page; what was local to this module was the "Reference: " label in front of
 * it, spelled three times in three different shapes.
 */
export function referenceLine(sessionId: string): string {
  return `Reference: ${orderReference(sessionId)}`;
}

/**
 * Build the subject and body for one kind. Pure: no I/O, no env reads.
 * Callers pass `siteUrl` in so this module stays free of config.ts.
 */
export function emailCopyFor(input: EmailCopyInput): EmailCopy {
  switch (input.kind) {
    case EMAIL_KINDS.orderConfirmation:
      return confirmationCopy(input.sessionId, input.siteUrl);
    case EMAIL_KINDS.printShipped:
      return shippedCopy(input);
    case EMAIL_KINDS.orderUnfulfilled:
      return unfulfilledCopy(input.sessionId);
  }
}

function confirmationCopy(sessionId: string, siteOrigin: string): EmailCopy {
  // Success page, not a token URL: the page is the one place that resolves
  // "is this digital-ready / physical / revoked" for a session the customer
  // already paid for.
  const successUrl = `${siteOrigin}/checkout/success?session_id=${sessionId}`;
  return {
    subject: "Your Nessebar Lens order",
    text: [
      "Thank you for your order.",
      "",
      "You can check its status here:",
      successUrl,
      "",
      "If you bought a digital copy, the download link is on that page once it is ready.",
      "If you bought a print, we will email you again when it ships.",
      "",
      referenceLine(sessionId),
      "",
      STUDIO_SIGNATURE,
    ].join("\n"),
  };
}

function shippedCopy(input: EmailCopyInput): EmailCopy {
  const trackingNumber = (input.trackingNumber ?? "").trim();
  const carrier = (input.carrier ?? "").trim();
  const trackingUrl = (input.trackingUrl ?? "").trim();
  const lines = [
    "Your print has shipped.",
    "",
  ];
  if (carrier) lines.push(`Carrier: ${carrier}`);
  if (trackingNumber) lines.push(`Tracking number: ${trackingNumber}`);
  if (trackingUrl) {
    lines.push(`Tracking: ${trackingUrl}`);
  }
  if (!carrier && !trackingNumber && !trackingUrl) {
    lines.push("Your carrier will provide tracking details separately.");
  }
  lines.push("", referenceLine(input.sessionId), "", STUDIO_SIGNATURE);
  return {
    subject: "Your Nessebar Lens print has shipped",
    text: lines.join("\n"),
  };
}

function unfulfilledCopy(sessionId: string): EmailCopy {
  return {
    subject: "We could not complete your Nessebar Lens order",
    text: [
      "We received your payment, but we could not complete your order automatically, so it has not gone into production yet. We will contact you by email about it.",
      "",
      referenceLine(sessionId),
      "",
      "Please reply to this email (or contact us via the site) and we will make it right — a refund or a fresh attempt, whichever you prefer.",
      "",
      STUDIO_SIGNATURE,
    ].join("\n"),
  };
}

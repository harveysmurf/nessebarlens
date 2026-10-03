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

import type { EmailKind } from "./email";

export type EmailCopyInput = {
  kind: EmailKind;
  sessionId: string;
  /** Absolute origin, no trailing slash — same contract as siteUrl(). */
  siteUrl: string;
  /** Tracking number for print-shipped; ignored by other kinds. */
  trackingNumber?: string;
  /** Carrier name for print-shipped; ignored by other kinds. */
  carrier?: string;
  /** Tracking URL for print-shipped; ignored by other kinds. */
  trackingUrl?: string;
};

export type EmailCopy = {
  subject: string;
  text: string;
};

/**
 * Build the subject and body for one kind. Pure: no I/O, no env reads.
 * Callers pass `siteUrl` in so this module stays free of config.ts.
 */
export function emailCopyFor(input: EmailCopyInput): EmailCopy {
  switch (input.kind) {
    case "order-confirmation":
      return confirmationCopy(input.sessionId, input.siteUrl);
    case "print-shipped":
      return shippedCopy(input);
    case "order-unfulfilled":
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
      "— Nessebar Lens",
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
  lines.push("", "— Nessebar Lens");
  return {
    subject: "Your Nessebar Lens print has shipped",
    text: lines.join("\n"),
  };
}

function unfulfilledCopy(sessionId: string): EmailCopy {
  return {
    subject: "We could not complete your Nessebar Lens order",
    text: [
      "We took payment for your order, but we could not complete fulfilment.",
      "",
      `Reference: ${sessionId}`,
      "",
      "Please reply to this email (or contact us via the site) and we will make it right — a refund or a fresh attempt, whichever you prefer.",
      "",
      "— Nessebar Lens",
    ].join("\n"),
  };
}

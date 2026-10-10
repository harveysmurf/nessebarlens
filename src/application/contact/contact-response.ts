/**
 * Contact outcome → HTTP response (#293).
 *
 * One place decides the status code and the copy a visitor sees, so the route
 * cannot improvise a different message and the mapping is testable as data. No
 * branch ever echoes an internal detail: validation errors name fields (which
 * the visitor already knows they filled), and everything else gets one generic
 * sentence. A 503 for "not configured" is emitted by the route itself, because
 * by then no submission has been attempted.
 */

import type { ContactOutcome } from "./submit-contact";

export const CONTACT_INVALID_ERROR = "Please check the highlighted fields.";
export const CONTACT_RATE_LIMITED_ERROR =
  "Too many messages from here. Please try again a little later.";
export const CONTACT_REJECTED_ERROR =
  "We couldn't verify that you're human. Please refresh the page and try again.";
export const CONTACT_DELIVERY_FAILED_ERROR =
  "Sorry, your message could not be sent. Please try again.";

export type ContactHttpResponse = {
  status: number;
  body: Record<string, unknown>;
};

export function contactResponse(outcome: ContactOutcome): ContactHttpResponse {
  switch (outcome.kind) {
    case "ok":
      return { status: 200, body: { ok: true } };
    case "invalid":
      return {
        status: 400,
        body: { error: CONTACT_INVALID_ERROR, fields: outcome.errors },
      };
    case "rate-limited":
      return { status: 429, body: { error: CONTACT_RATE_LIMITED_ERROR } };
    case "rejected":
      return { status: 400, body: { error: CONTACT_REJECTED_ERROR } };
    case "delivery-failed":
      return { status: 502, body: { error: CONTACT_DELIVERY_FAILED_ERROR } };
  }
}

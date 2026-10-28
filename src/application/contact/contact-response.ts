/**
 * Contact outcome → HTTP response (#293).
 *
 * One place decides the status code and the code the browser reads, so the
 * route cannot improvise a different answer and the mapping is testable as
 * data. No branch ever echoes an internal detail, and no branch carries a
 * sentence: the copy for a code lives in the dictionary and is rendered by the
 * client, in the reader's language. Validation errors name the fields (which
 * the visitor already knows they filled) and the code of each. A 503 for "not
 * configured" is emitted by the route itself, because by then no submission has
 * been attempted.
 */

import { CONTACT_ATTEMPT_STATUSES } from "../../domain/contact/contact-status";
import type { ContactOutcome } from "./submit-contact";

export type ContactHttpResponse = {
  status: number;
  body: Record<string, unknown>;
};

export function contactResponse(outcome: ContactOutcome): ContactHttpResponse {
  switch (outcome.kind) {
    case CONTACT_ATTEMPT_STATUSES.ok:
      return { status: 200, body: { ok: true } };
    case CONTACT_ATTEMPT_STATUSES.invalid:
      return {
        status: 400,
        body: {
          code: CONTACT_ATTEMPT_STATUSES.invalid,
          fields: outcome.errors,
        },
      };
    case CONTACT_ATTEMPT_STATUSES.rateLimited:
      return { status: 429, body: { code: CONTACT_ATTEMPT_STATUSES.rateLimited } };
    case CONTACT_ATTEMPT_STATUSES.rejected:
      return { status: 400, body: { code: CONTACT_ATTEMPT_STATUSES.rejected } };
    case CONTACT_ATTEMPT_STATUSES.deliveryFailed:
      return {
        status: 502,
        body: { code: CONTACT_ATTEMPT_STATUSES.deliveryFailed },
      };
  }
}

/**
 * The postcode a print order actually ships to (#195).
 *
 * Stripe's `shipping_address_collection` cannot mark the postal code required:
 * for BG the hosted form treats it as optional, so a customer can pay with
 * `address.postal_code = ""`. Prodigi then rejects the order
 * (`MustNotBeEmptyOrWhitespace` / `Required`) and we hold a paid order that can
 * never be fulfilled. So the physical checkout session carries a *required*
 * `custom_fields` entry as well, and this module is the one place that decides
 * which value is authoritative and whether it is well-formed.
 *
 * Precedence: Stripe's address wins when it has a value; the custom field is the
 * fallback. A customer who typed the postcode twice with different values is not
 * a case we can adjudicate, and Prodigi will reject the wrong one — but the
 * address is the one Stripe validated against the locked destination country.
 */

import type Stripe from "stripe";

export const POSTCODE_CUSTOM_FIELD_KEY = "postcode";

/** POSTCODE_MAX in order-decision; mirrored so the two stay visibly paired. */
const POSTCODE_MAX = 32;

/**
 * Shape of the `custom_fields` entry as Stripe sends it back. Only the two keys
 * we read are declared — a Stripe event is untrusted input and the parser is a
 * narrowing step, not a cast.
 */
export type StripeCustomField = {
  key?: string | null;
  text?: { value?: string | null } | null;
};

/**
 * The `custom_fields` definition to put on a physical Checkout Session.
 *
 * `optional: false` is the point of the whole exercise: Stripe then refuses to
 * complete the session without it. The length window is 2–10, which covers BG
 * (4) and the alphanumeric formats of the shipping countries we quote, without
 * pretending to know every country's postal grammar — the per-country check in
 * `isValidPostcode` is where precision lives.
 */
type StripeCustomFieldParam =
  Stripe.Checkout.SessionCreateParams.CustomField;

export const POSTCODE_CUSTOM_FIELD: StripeCustomFieldParam = {
  key: POSTCODE_CUSTOM_FIELD_KEY,
  // Cast: the SDK types `label` as its `Label` template-literal type, which a
  // plain literal does not satisfy. Runtime accepts any string.
  label: "Postcode" as unknown as Stripe.Checkout.SessionCreateParams.CustomField.Label,
  type: "text" as const,
  optional: false,
  text: { minimum_length: 2, maximum_length: 10 },
};

/**
 * The required-postcode entry, or an empty list for a digital session. Always
 * assigned, so the field is present-and-optional=false on a print and simply
 * absent (as `[]`) on a download — Stripe rejects an optional field definition.
 */
export function postcodeCustomFields(
  isPhysical: boolean,
): StripeCustomFieldParam[] {
  return isPhysical ? [POSTCODE_CUSTOM_FIELD] : [];
}

/**
 * Read the postcode custom field off a session's `custom_fields` array.
 *
 * Returns the trimmed value, or null when the field is absent, is not our key,
 * carries no text, or is blank. Never throws: this runs on a paid webhook, and
 * a malformed array must fall through to `parseRecipient`'s rejection rather
 * than 500 a delivery Stripe would redeliver.
 */
export function postcodeFromCustomFields(
  fields: unknown,
): string | null {
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const entry = field as StripeCustomField;
    if (entry.key !== POSTCODE_CUSTOM_FIELD_KEY) continue;
    const value = (entry.text?.value ?? "").trim();
    return value.length > 0 ? value.slice(0, POSTCODE_MAX) : null;
  }
  return null;
}

/**
 * Per-country postcode check, applied where it is cheap.
 *
 * BG is our only shipping country today (`ship-to-countries.ts` allows a small
 * set), and a 4-digit check there catches the typo that Prodigi would otherwise
 * reject mid-order — after we took the money. Countries we do not know are
 * never rejected on a guess: an over-strict rule would refuse a valid address,
 * which is the worse failure for a paid order. Length is Stripe's job, not
 * ours — the custom field caps at 2–10 and Stripe validates the address's own
 * postcode against the destination country.
 */
const POSTCODE_PATTERNS: Record<string, RegExp> = {
  BG: /^\d{4}$/,
};

export function isValidPostcode(
  countryCode: string,
  postcode: string,
): boolean {
  const pattern = POSTCODE_PATTERNS[countryCode.trim().toUpperCase()];
  if (!pattern) return true;
  return pattern.test(postcode);
}

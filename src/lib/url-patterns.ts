/**
 * Grammars that are about URLs rather than about one domain.
 *
 * The https check lives here rather than being written inline in
 * prodigi-order.ts and fulfillment.ts. Two copies of "is this an absolute
 * https URL" is exactly the
 * shape of thing that drifts: one of them is the gate in front of the masters
 * bucket check, so a divergent copy is a leak, not a style nit.
 */
export const HTTPS_URL_PATTERN = /^https:\/\//i;

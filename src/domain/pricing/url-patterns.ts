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

/**
 * Strips every trailing slash so callers can concatenate "/path" safely.
 * Every slash, not just one: the single-slash version silently left a
 * doubled slash in a caller-supplied base and produced "//api/…" URLs.
 *
 * Moved from `infrastructure/config/env.ts` to domain so `application/fulfillment/print-asset.ts`
 * (and any other app module) can use it without importing infrastructure.
 */
export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

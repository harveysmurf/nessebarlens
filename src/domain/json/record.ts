/**
 * The one guard for "this parsed value is an object I can read keys off".
 *
 * Narrowing an `unknown` with a type assertion asserts a shape instead of
 * checking it, and every JSON body, KV value and webhook payload in this
 * codebase arrived as `unknown`. #386 collects the 23 record assertions that
 * did; this is the narrowing they all wanted.
 *
 * Arrays are rejected deliberately. `typeof [] === "object"` and `[] !== null`,
 * so the two-line check most call sites already wrote let an array through and
 * then read `undefined` off it — a `NaN` in the geometry, an `[object Object]`
 * in an email, or a silently swallowed field, several frames from the payload
 * that caused it. An array here is never a map we wanted, so failing it at the
 * boundary is the honest answer.
 *
 * Note this is narrower than `typeof value === "object" && value !== null`, not
 * wider: it rejects a case that check accepted. A `Date` or `Map` still passes,
 * matching `isMapping`, the stricter of the two guards it replaces -- every
 * caller reads a named own key and falls back when it is `undefined`, which is
 * what those objects produce anyway. Domain guards in this layer must not
 * import from `infrastructure/`, which is what makes one shared guard possible
 * at all.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * One definition of "this value points at private master media".
 *
 * Three call sites used to each carry their own copy — two case-insensitive
 * regexes and one case-sensitive `includes` pair — so the same string could be
 * rejected by the Prodigi order body and accepted by the stored-record
 * validator. Masters live in the private bucket; nothing outside this module
 * should ever name one.
 */

/** Private bucket name that must never appear in a URL we hand out. */
export const MASTERS_BUCKET = "nessebar-lens-masters";

/** Any casing of the master key prefix or bucket name. */
const MASTER_MARKER = /prints\/|nessebar-lens-masters/i;

/**
 * True when the value references the masters bucket or a `prints/` master key
 * path. Case-insensitive: a URL is a URL whatever case the path uses, and
 * R2 keys are case-sensitive, so the loose match is the safe direction.
 */
export function referencesMasters(value: string): boolean {
  return MASTER_MARKER.test(value);
}

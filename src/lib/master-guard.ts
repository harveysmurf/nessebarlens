/**
 * One definition of "this value points at private master media".
 *
 * Three call sites used to each carry their own copy — two case-insensitive
 * regexes and one case-sensitive `includes` pair — so the same string could be
 * rejected by the Prodigi order body and accepted by the stored-record
 * validator. Masters live in the private bucket; nothing outside this module
 * should ever name one.
 */

// The name itself is declared once, next to the derivative ladder that
// writes into it — this module is about *what counts as pointing at
// masters*, not about spelling the bucket. The regex below stays a literal:
// tests/single-source-grammar.test.mts pins its exact source here, and
// rebuilding it from the constant would hide the marker from that test.
import { MASTERS_BUCKET_NAME } from "./derivative-ladder";

/** Private bucket name that must never appear in a URL we hand out. */
export const MASTERS_BUCKET = MASTERS_BUCKET_NAME;

/** Any casing of the master key prefix or bucket name. */
export const MASTER_MARKER = new RegExp(
  // The bucket name is interpolated, not re-spelled: a rename would otherwise
  // silently stop this guard matching the new bucket. The `prints\/` half
  // stays a literal so the source-grammar test can see the pattern here.
  `prints\\/|${MASTERS_BUCKET_NAME}`,
  "i",
);

/**
 * True when the value references the masters bucket or a `prints/` master key
 * path. Case-insensitive: a URL is a URL whatever case the path uses, and
 * R2 keys are case-sensitive, so the loose match is the safe direction.
 */
export function referencesMasters(value: string): boolean {
  return MASTER_MARKER.test(value);
}

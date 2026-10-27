/**
 * The shape of a path: a route, and the query string or fragment that may
 * follow it.
 *
 * This module owns the one thing both of its callers need to agree on — where
 * the tail begins. The locale path helper has to keep the tail, because a
 * print's selection lives in the query string and a switch to another language
 * must carry it across; the analytics route has to drop it, because a path
 * with a query string in it is not a path, and writing one into the dataset
 * would file a URL as a page.
 *
 * Two copies of the "?" or "#" boundary is how a divergent copy starts: one
 * caller would keep the tail and the other would not, and the difference would
 * be a query string that reaches a dataset. So the boundary is written down
 * here, once, and both callers ask this module where it is.
 */

/** The parts a path is made of. */
export type PathParts = {
  /** The path up to the first "?" or "#". */
  route: string;
  /** The query string or fragment, with its leading "?" or "#". */
  tail: string;
};

/**
 * The one declaration of the boundary.
 *
 * A "?" starts a query string and a "#" starts a fragment; whichever comes
 * first ends the route.
 */
const TAIL_START = /[?#]/;

/**
 * The path split at its first "?" or "#".
 *
 * A path with neither is all route and no tail, and the tail it does have is
 * returned with its marker, so a caller that re-joins the two gets the path it
 * was given.
 */
export function splitPathParts(path: string): PathParts {
  const index = path.search(TAIL_START);
  if (index === -1) return { route: path, tail: "" };
  return { route: path.slice(0, index), tail: path.slice(index) };
}

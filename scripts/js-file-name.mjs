/**
 * The one definition of "this path names a JavaScript/TypeScript module".
 *
 * Two modules need the answer — the resolve hook, which uses it to decide
 * whether a specifier already carries an extension, and the coverage parser,
 * which uses it to tell a file row from a directory row in node's report — and
 * a drifting copy of the pattern between them is the kind of single-source
 * violation `tests/single-source-grammar.test.mts` exists to fail on.
 */

/** Matches a path ending in a JavaScript/TypeScript extension: the base .js/.jsx/.ts/.tsx, each optionally prefixed with `m` or `c` and suffixed with `s` (so .mjs, .mts, .cts and the theoretical .mjsx match too). */
export const FILE_NAME = /\.[cm]?[jt]sx?$/;

/**
 * Parameterised SQL inlined for printing and for `wrangler d1 execute`.
 *
 * Shared by the orders migration and the operator view because both have to
 * render the same `?` placeholders the same way. A second copy of the quoting
 * rules is a second place where a session id or a status can be rendered as
 * SQL rather than as a value, and the operator view is precisely the tool an
 * engineer copies a statement out of into the D1 dashboard.
 *
 * Every value that reaches here has already passed a closed-set allow-list or an
 * integer clamp in the calling script. That is the invariant this file relies
 * on: it quotes, it does not decide what is allowed. Numbers are emitted bare
 * because a quoted number is a string literal in SQL and would compare against
 * nothing; NULL is emitted as the keyword because `''` is not the same answer.
 */

const PLACEHOLDER = /\?/g;
const SINGLE_QUOTE = /'/g;

/** Render one bind as a SQL literal. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(SINGLE_QUOTE, "''")}'`;
}

/** Substitute `?` placeholders in `sql` with `binds`, in order. */
export function sqlWithBinds(sql, binds) {
  let i = 0;
  return sql.replace(PLACEHOLDER, () => {
    if (i >= binds.length) {
      throw new Error(`sql has more placeholders than the ${binds.length} bind(s) given`);
    }
    return sqlLiteral(binds[i++]);
  });
}

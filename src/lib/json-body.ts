/**
 * The one place a request body is read as JSON.
 *
 * quote and checkout each hand-rolled `try { await request.json() } catch` and
 * each answered with its own `400 { error: "Invalid JSON" }`. Two copies of a
 * parse-and-reject grammar is the same drift shape as the hex, url and
 * header constants this repo has already had to single-source, and here a
 * divergent copy would mean the two endpoints disagree about what a malformed
 * body is.
 *
 * The module stays free of `next/server` so it can be unit tested as a plain
 * function: it returns the parse result and owns the status and error string
 * the caller must echo back, while the caller keeps owning the response.
 */
export const INVALID_JSON_ERROR = "Invalid JSON";
export const INVALID_JSON_STATUS = 400;

export type ParsedJsonBody =
  | { ok: true; value: unknown }
  | { ok: false; error: string; status: number };

/**
 * Read and parse a JSON request body, reporting a malformed body as the
 * canonical rejection rather than an exception, so callers branch once.
 */
export async function readJsonBody(request: Request): Promise<ParsedJsonBody> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      error: INVALID_JSON_ERROR,
      status: INVALID_JSON_STATUS,
    };
  }
}

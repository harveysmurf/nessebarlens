/**
 * One owner for "POST JSON to our own API".
 *
 * Four call sites wrote the rule themselves: the interaction beacon, the
 * contact form and the two configurator requests. Each spelled the method, the
 * content type and the serialisation, and each was free to spell them
 * differently — a request that arrives without the content type is refused by
 * the API's JSON reader, and four spellings are four chances to forget it.
 *
 * The two options are the ones the call sites actually needed: the beacon
 * outlives the page it was sent from, and the quote is abandoned when the
 * customer changes their mind. Everything else about the request stays with
 * the caller, because what a request *means* is the caller's business.
 */

export type PostJsonOptions = {
  /** Abandons the request when the caller gives up on it. */
  signal?: AbortSignal;
  /** Lets the request outlive the page that sent it. */
  keepalive?: boolean;
};

export function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.keepalive !== undefined) init.keepalive = options.keepalive;
  return fetch(url, init);
}

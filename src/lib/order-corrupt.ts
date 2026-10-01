/**
 * The one place a stored order record is found unreadable.
 *
 * A record that exists under a Checkout Session id but will not parse is money
 * taken and no deliverable: the customer is told we could not read their order
 * and an operator sees nothing. Before this module the read paths
 * (`/api/download`, `/api/order-status`, the checkout success page) each
 * returned an error and stayed silent, while only the refund path logged.
 *
 * Two rules hold here and are the reason this is one module rather than a
 * `console.error` in each route:
 *
 * 1. **One call site for the log.** A shape emitted from three routes is three
 *    alerts to reconcile, and the one that gets edited is the one whose format
 *    drifts.
 * 2. **The diagnosis never carries customer data.** The raw record holds a
 *    name, an address and a master key. What an operator needs to act is
 *    *which check* rejected it and *how big* the value was — so those are what
 *    this logs, and the bytes stay in KV where a human with the right access can
 *    read them.
 */

import { parseOrderRecord, type OrderRecord } from "./order-decision";

/** Which reader found it. Named so an alert says where to look. */
export type CorruptOrderPath =
  "download" | "order-status" | "page" | "revoke" | "webhook";

/**
 * Facts about a rejected record that identify the failure without reproducing
 * it. Every field is either a count, a boolean, or a version number — nothing
 * here can be a name, an address, a URL or a key.
 */
export type CorruptOrderFacts = {
  /** Bytes read out of KV, so "empty" and "truncated mid-write" are told apart. */
  bytes: number;
  /** Whether the value was JSON at all, as opposed to valid JSON of the wrong shape. */
  json: boolean;
  /** The record's own schema version, when it had one — the usual cause is a writer on a newer shape. */
  version: number | null;
  /** Whether the key it was filed under is the session id it names. A record filed under the wrong key is a different bug from a corrupt one. */
  keyMatches: boolean;
};

/**
 * Describe a record the parser rejected, without reading the record's contents.
 *
 * `parseOrderRecord` returns null for ~20 distinct reasons and does not say
 * which; this recovers only the two cheap discriminators an operator acts on
 * (is it JSON at all, is it a version this code knows) plus the key check the
 * callers were already making by hand.
 */
export function describeCorruptOrder(
  raw: string,
  expectedSessionId: string,
): CorruptOrderFacts {
  const keyMatches = raw.includes(expectedSessionId);
  let json = false;
  let version: number | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    json = true;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>).v;
      if (typeof v === "number") version = v;
    }
  } catch {
    json = false;
  }
  return { bytes: raw.length, json, version, keyMatches };
}

/**
 * Parse a stored record for a read path, and log it if it will not parse.
 *
 * Returns the record only when the parser accepted it *and* it names the key it
 * was filed under — the second check is the caller's, and folding it in here is
 * what lets all three read paths share one failure shape.
 */
export function readOrderRecord(
  raw: string,
  expectedSessionId: string,
  path: CorruptOrderPath,
): OrderRecord | null {
  const order = parseOrderRecord(raw);
  if (order !== null && order.sessionId === expectedSessionId) return order;
  reportCorruptOrder(
    expectedSessionId,
    path,
    describeCorruptOrder(raw, expectedSessionId),
  );
  return null;
}

/** Log-only half, for callers that already have the facts and their own shape. */
export function reportCorruptOrder(
  sessionId: string,
  path: CorruptOrderPath,
  facts: CorruptOrderFacts,
): void {
  console.error(
    JSON.stringify({ event: "order.corrupt", sessionId, path, ...facts }),
  );
}

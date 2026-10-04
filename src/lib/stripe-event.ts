import Stripe from "stripe";
import {
  HEX_64_PATTERN,
  hmacSha256Hex,
  timingSafeEqualHex,
} from "./crypto-hex";
import type { StripeShippingDetails } from "./order-decision";
import type { StripeCustomField } from "./postcode";

const TOLERANCE_SECONDS = 300;

export type ConstructEvent = (
  payload: string,
  header: string,
  secret: string,
) => Stripe.Event;

/**
 * Verify the raw body. Node `constructEvent` runs when it can.
 * If that throws for a reason other than a bad signature, verify with Web Crypto.
 * A signature failure stays a failure. This does not start a Node server.
 */
export async function readStripeEvent(
  payload: string,
  header: string,
  secret: string,
  options?: { construct?: ConstructEvent; nowMs?: number },
): Promise<Stripe.Event> {
  const construct =
    options?.construct ??
    ((body, signature, webhookSecret) =>
      Stripe.webhooks.constructEvent(body, signature, webhookSecret));
  try {
    return construct(payload, header, secret);
  } catch (error) {
    if (isSignatureVerificationError(error)) throw error;
    const verified = await verifyStripeSignatureWebCrypto(
      payload,
      header,
      secret,
      options?.nowMs ?? Date.now(),
    );
    if (!verified) throw error;
    return parseStripeEvent(payload);
  }
}

export async function verifyStripeSignatureWebCrypto(
  payload: string,
  header: string,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!payload || !header || !secret) return false;
  const timestamp = headerTimestamp(header);
  const signatures = headerSignatures(header);
  if (timestamp === null || signatures.length === 0) return false;
  // Bound both ends: a future timestamp makes `age` negative, so an upper-only
  // check would accept it and keep the signature replayable until the clock
  // caught up. ±tolerance is what Stripe itself enforces.
  const age = Math.floor(nowMs / 1000) - timestamp;
  if (age > TOLERANCE_SECONDS || age < -TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
  return signatures.some((signature) => timingSafeEqualHex(expected, signature));
}

/**
 * The fields the webhook reads off a Checkout Session. Declared here so the
 * handler stops re-typing Stripe's shipping shape inline — it had two copies
 * of the same nested address object, one per place Stripe can put it.
 */
export type StripeCheckoutSession = {
  id?: string;
  payment_status?: string | null;
  currency?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string> | null;
  shipping_details?: StripeShippingDetails | null;
  collected_information?: {
    shipping_details?: StripeShippingDetails | null;
  } | null;
  customer_details?: {
    email?: string | null;
    phone?: string | null;
  } | null;
  custom_fields?: StripeCustomField[] | null;
};

function parseStripeEvent(payload: string): Stripe.Event {
  const parsed = JSON.parse(payload) as Stripe.Event;
  if (!parsed || parsed.object !== "event" || typeof parsed.type !== "string") {
    throw new Error("invalid-event");
  }
  return parsed;
}

function isSignatureVerificationError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeSignatureVerificationError;
}

// Wire order, first `=` only, and a part with no `=` is skipped rather than
// fatal. The two readers below differ deliberately: the timestamp takes the
// first `t=` it sees, while signatures collects every well-formed `v1=`.
function headerParts(header: string): Array<[string, string]> {
  const parts: Array<[string, string]> = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    parts.push([part.slice(0, eq), part.slice(eq + 1)]);
  }
  return parts;
}

function headerTimestamp(header: string): number | null {
  for (const [key, value] of headerParts(header)) {
    if (key !== "t") continue;
    const timestamp = Number(value);
    if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
    return timestamp;
  }
  return null;
}

function headerSignatures(header: string): string[] {
  const signatures: string[] = [];
  for (const [key, value] of headerParts(header)) {
    if (key !== "v1") continue;
    if (HEX_64_PATTERN.test(value)) signatures.push(value);
  }
  return signatures;
}

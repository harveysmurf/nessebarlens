import Stripe from "stripe";
import { hmacSha256Hex, timingSafeEqualHex } from "./crypto-hex";

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
  const age = Math.floor(nowMs / 1000) - timestamp;
  if (age > TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
  return signatures.some((signature) => timingSafeEqualHex(expected, signature));
}

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

function headerTimestamp(header: string): number | null {
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) !== "t") continue;
    const timestamp = Number(part.slice(eq + 1));
    if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
    return timestamp;
  }
  return null;
}

function headerSignatures(header: string): string[] {
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) !== "v1") continue;
    const signature = part.slice(eq + 1);
    if (/^[0-9a-f]{64}$/.test(signature)) signatures.push(signature);
  }
  return signatures;
}

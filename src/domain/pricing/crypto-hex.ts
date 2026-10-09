/** Shared Web Crypto HMAC-SHA256 hex helpers (Workers + Node). */

/**
 * A SHA-256 signature as hex. Owned here because two modules verify HMACs with
 * it — stripe-event.ts and print-asset.ts — rather than each carrying its own
 * copy of the same literal.
 */
export const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;

export async function hmacSha256Hex(
  content: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(content),
  );
  const bytes = new Uint8Array(signature);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Constant-time hex compare; case-insensitive (hex is not case-sensitive). */
export function timingSafeEqualHex(expected: string, actual: string): boolean {
  const a = expected.toLowerCase();
  const b = actual.toLowerCase();
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Constant-time string compare for non-hex secrets (reconcile shared secret).
 *
 * Length is still compared first — a mismatch returns false immediately, which
 * leaks length the same way `timingSafeEqualHex` does. The bytes that are
 * compared run in fixed time for equal-length inputs.
 */
export function timingSafeEqualString(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Shared Web Crypto HMAC-SHA256 hex helpers (Workers + Node). */

/**
 * A SHA-256 signature as hex. Owned here because two modules verify HMACs with
 * it — stripe-event.ts and print-asset.ts — rather than each carrying its own
 * copy of the same literal.
 */
export const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * A 16-byte value as 32 lowercase hex characters — a download token, or a print
 * asset's MD5 (#307). Owned here with `HEX_64_PATTERN` so the repository has one
 * declaration of "what a 32-hex value looks like" rather than a copy per field.
 */
export const HEX_32_PATTERN = /^[0-9a-f]{32}$/;

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

/**
 * Constant-time compare of two strings, and the only rule either public
 * compare below has: the length is compared first, which leaks length the way
 * every compare of this shape does, and the bytes themselves run in fixed time
 * for equal-length inputs.
 *
 * Both compares are this one, so "constant-time" cannot mean two different
 * things in one module.
 */
function constantTimeEquals(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Constant-time hex compare; case-insensitive (hex is not case-sensitive). */
export function timingSafeEqualHex(expected: string, actual: string): boolean {
  return constantTimeEquals(expected.toLowerCase(), actual.toLowerCase());
}

/**
 * Constant-time string compare for non-hex secrets (reconcile shared secret).
 *
 * The length is compared first, exactly as in `timingSafeEqualHex`.
 */
export function timingSafeEqualString(expected: string, actual: string): boolean {
  return constantTimeEquals(expected, actual);
}

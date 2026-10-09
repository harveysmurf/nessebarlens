/**
 * Vendor-neutral session-origin classifier.
 *
 * Owned by the domain so origin comparison needs no Stripe session shape. The
 * function takes a URL string, not a Stripe object — the caller (webhook route
 * or reconciler) passes the `success_url` it already has.
 *
 * Stripe test mode has one event stream and one set of webhook endpoints per
 * account, so every endpoint receives every session — a staging purchase is
 * delivered to the production handler and vice versa.
 */

/**
 * Scheme + host + port with one leading `www.` removed, compared as parsed
 * origins (never prefix or substring, so `staging.x.com.evil.com` and
 * `x.com.evil.com` stay foreign). www and the apex are one deployment: the
 * Worker serves both from the same NEXT_PUBLIC_SITE_URL, so a session whose
 * success_url names the other spelling is still ours.
 *
 * Subdomains such as `staging.` are deliberately NOT folded.
 */
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  const host = url.host.replace(/^www\./, "");
  return `${url.protocol}//${host}`;
}

/**
 * Did this Checkout Session belong to this deployment? (#193)
 *
 * Three-valued on purpose. `unknown` — no readable success_url — is *not*
 * foreign, and is accepted: refusing an unreadable session would drop a
 * customer's paid print, and this check refines the Prodigi-side one rather
 * than replacing it.
 */
export function classifyUrlOrigin(
  successUrl: string | null | undefined,
  expectedOrigin: string,
): "ours" | "foreign" | "unknown" {
  const trimmed = (successUrl ?? "").trim();
  if (!trimmed) return "unknown";
  try {
    return canonicalOrigin(trimmed) === canonicalOrigin(expectedOrigin)
      ? "ours"
      : "foreign";
  } catch {
    // Unparseable is not evidence of a foreign session, so it is unknown
    // rather than a rejection.
    return "unknown";
  }
}

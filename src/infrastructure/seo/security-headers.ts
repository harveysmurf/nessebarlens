/**
 * The security headers every response carries, and the CSP string itself.
 *
 * Zero imports, on purpose, and not as a style choice: `next.config.ts` imports
 * this module to build `headers()`, and `tests/no-workerd-in-build.test.mts`
 * evaluates that config in a bare `node` process whose only resolve hook stubs
 * `@opennextjs/cloudflare`. A module here that reached into `config/config.ts`
 * would drag the Prodigi readers and the env surface into that probe for no
 * gain. So the one input — the image origin — is passed in rather than read, and
 * `next.config.ts` does the reading.
 *
 * `'unsafe-inline'` in `script-src` is required and is not a leftover: Next's
 * inline bootstrap script and React's hydration payload are inline, and the
 * repository is not set up for a per-request nonce. A nonce migration is its own
 * change with its own staging proof; this header is the state that can be
 * proven today, and the directives below it (`object-src 'none'`,
 * `frame-ancestors 'none'`, `base-uri 'self'`) are the ones that stop an
 * injected script from doing anything. Revisit with #438's follow-up rather than
 * guessing at a hash here.
 *
 * The two Cloudflare origins are named constants rather than literals in the
 * string, because a dropped origin is a silently broken contact form — the
 * Turnstile widget would fail to render with no error anywhere in our logs.
 * `tests/security-headers.test.mts` asserts each one is present, so removing a
 * directive is a failing test rather than a production surprise.
 */

/** Turnstile: the script is loaded from here and the widget runs in an iframe. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Cloudflare Web Analytics: the beacon script is served from here. */
export const ANALYTICS_ORIGIN = "https://static.cloudflareinsights.com";

/**
 * The origin of a configured base URL, or undefined when unset or unparseable.
 *
 * `NEXT_PUBLIC_WEB_IMAGES_BASE` is an R2 custom domain
 * (`https://images.nessebarlens.com`, see DEVELOPMENT.md §6a) whose ladder every
 * gallery `<img>` points at. Without it in `img-src` the site renders as
 * unstyled boxes: the CSP blocks the image requests, and the page looks broken
 * rather than blocked.
 */
export function originOf(base: string | undefined): string | undefined {
  const raw = base?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export type SecurityHeaderOptions = {
  /**
   * Add `'unsafe-eval'` to `script-src`, for the dev server only.
   *
   * React's development build calls `eval()` for call-stack reconstruction and
   * the React DevTools hook, and Next's dev server adds its own. Shipping the
   * production policy to `next dev` therefore logs
   * "eval() is not supported in this environment" on every page load — noise a
   * developer cannot act on, and noise that trains people to ignore the one
   * console message that *would* matter.
   *
   * React never calls `eval()` in a production build, so the token has no reason
   * to exist in what ships. It is scoped to `NODE_ENV === "development"` in
   * `next.config.ts`, and `tests/security-headers.test.mts` asserts the two
   * policies differ by exactly that one token and by nothing else — so the dev
   * relaxation cannot quietly widen into a production hole, and the dev policy
   * still exercises every origin and directive the e2e suite would break on.
   */
  allowEval?: boolean;
};

/**
 * The Content-Security-Policy for the site.
 *
 * `imageOrigin` is the R2/custom-domain origin the gallery serves from; omitted,
 * the policy still names every other source, so a build without
 * `NEXT_PUBLIC_WEB_IMAGES_BASE` gets a valid (image-starved) policy rather than
 * an unparseable one.
 */
export function contentSecurityPolicy(
  imageOrigin?: string,
  options: SecurityHeaderOptions = {},
): string {
  const imgSources = ["'self'", "data:", "blob:", imageOrigin]
    .filter((source): source is string => Boolean(source))
    .join(" ");

  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    options.allowEval ? "'unsafe-eval'" : undefined,
    TURNSTILE_ORIGIN,
    ANALYTICS_ORIGIN,
  ]
    .filter((source): source is string => Boolean(source))
    .join(" ");

  return [
    "default-src 'self'",
    // Turnstile's widget renders cross-origin frames and calls back into the
    // page; the analytics beacon is a script tag from its own origin.
    `script-src ${scriptSources}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${imgSources}`,
    // The configurator previews the chosen file with a blob: URL.
    `font-src 'self'`,
    // The quote and checkout fetches, plus the analytics beacon's reporting.
    `connect-src 'self' ${ANALYTICS_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
  ].join("; ");
}

/**
 * The headers applied to every route, in `next.config.js` `headers()` shape.
 *
 * `X-Frame-Options: DENY` is redundant with `frame-ancestors 'none'` and is kept
 * because it is the only one of the two a 2011-era crawler or an embedding
 * preview understands. HSTS is deliberately *not* here: it is set once at the
 * Cloudflare zone (`max-age=31536000`, no `includeSubDomains`, no preload), and
 * a second copy in the app is a second value to drift.
 */
export function securityHeaders(
  imageOrigin?: string,
  options?: SecurityHeaderOptions,
): { key: string; value: string }[] {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      key: "Content-Security-Policy",
      value: contentSecurityPolicy(imageOrigin, options),
    },
  ];
}
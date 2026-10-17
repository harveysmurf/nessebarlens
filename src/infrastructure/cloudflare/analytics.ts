/**
 * Analytics Engine writes (#119).
 *
 * Deliberate events only, written server-side. Every writer here is best-effort:
 * the binding is optional, `writeDataPoint` is wrapped in try/catch, and no
 * function returns or throws anything a request can act on. Analytics must never
 * turn a 200 into a 500 or a 400 into a 500.
 *
 * Blob order is the read contract, documented in AGENTS.md:
 *   contact        blobs: ["contact", status, env]
 *   interaction    blobs: [event, path, env]
 *
 * Never write name, email, message, IP or user agent here. `status` and `path`
 * are the only visitor-derived values, and both are closed/normalised before
 * they reach this module.
 */

import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

type Analytics = AnalyticsEngineDataset | undefined;

/**
 * One point per contact submission attempt, including the ones rejected before
 * `submitContact` (malformed body, unconfigured deployment). `status` is the
 * closed set owned by the route: "malformed" | "unconfigured" | ContactOutcome
 * kind. No PII.
 */
export function recordContactAttempt(
  analytics: Analytics,
  env: string,
  status: string,
): void {
  write(analytics, {
    blobs: ["contact", status, env],
    doubles: [1],
    indexes: ["contact"],
  });
}

/**
 * One point per allowlisted interaction. `path` has already been checked and
 * stripped of query/hash by the route.
 */
export function recordInteraction(
  analytics: Analytics,
  env: string,
  event: string,
  path: string,
): void {
  write(analytics, {
    blobs: [event, path, env],
    doubles: [1],
    indexes: [event],
  });
}

function write(
  analytics: Analytics,
  point: {
    blobs: string[];
    doubles: number[];
    indexes: string[];
  },
): void {
  if (!analytics) return;
  try {
    analytics.writeDataPoint(point);
  } catch {
    // Intentionally swallowed. A metric is not worth a failed request, and the
    // caller has no recovery path for an analytics outage.
  }
}

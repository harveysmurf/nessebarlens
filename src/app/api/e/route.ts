/**
 * POST /api/e — the thin interaction beacon (#119).
 *
 * Deliberate events only, exact allowlist, no AE credentials in the browser.
 * The response is always 204, including malformed bodies, unknown events and
 * rate-limited callers: the endpoint must not be an oracle for what the
 * allowlist contains, and a beacon failure is never worth surfacing.
 *
 * The path is validated and stripped of query/hash before it is written, and
 * the only visitor-derived values that reach Analytics Engine are that path and
 * the event name.
 */

import { readJsonBody } from "@/infrastructure/config/json-body";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";
import { recordInteraction } from "@/infrastructure/cloudflare/analytics";
import { isTrackEvent } from "@/analytics/events";
import { splitPathParts } from "@/domain/paths/path-parts";

const MAX_PATH_LENGTH = 200;

function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * A path worth recording: absolute, bounded, and never carrying a query string
 * or fragment into the dataset.
 */
function normalisePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.length > MAX_PATH_LENGTH) return undefined;
  // The first character is "/", which is neither "?" nor "#", so splitting can
  // never produce an empty first segment. The boundary itself belongs to
  // `domain/paths/path-parts.ts`: the locale path helper keeps the tail, this
  // one drops it, and two copies of the rule is how they would drift apart.
  return splitPathParts(value).route;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok || typeof body.value !== "object" || body.value === null) {
    return noContent();
  }
  const record = body.value as { event?: unknown; path?: unknown };
  if (!isTrackEvent(record.event)) return noContent();
  const path = normalisePath(record.path);
  if (path === undefined) return noContent();

  const bindings = await readWorkerBindings();

  // Generous per-IP cap. A broken limiter degrades to the write rather than to
  // a dropped beacon: this is quota defence, not authentication.
  if (bindings.analyticsRateLimiter) {
    const key = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    try {
      const { success } = await bindings.analyticsRateLimiter.limit({ key });
      if (!success) return noContent();
    } catch {
      // Fall through and record; see above.
    }
  }

  recordInteraction(
    bindings.analytics,
    bindings.analyticsEnv,
    record.event,
    path,
  );
  return noContent();
}

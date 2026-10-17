/**
 * Client helper for the interaction beacon (#119).
 *
 * Fire-and-forget by design: `keepalive` lets the request survive the
 * navigation a click may trigger, and every failure is swallowed. This is
 * called from render effects and click handlers — it must never delay a render,
 * surface an error or run during SSR.
 */

import type { TrackEvent } from "./events";

export function track(event: TrackEvent): void {
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, path: window.location.pathname }),
      keepalive: true,
    }).catch(() => {
      // A lost beacon is not a user-facing failure.
    });
  } catch {
    // Same, for a synchronous throw from fetch itself.
  }
}

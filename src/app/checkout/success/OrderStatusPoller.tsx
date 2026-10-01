"use client";

import { useEffect, useState } from "react";

/**
 * Polls /api/order-status until the download is ready, then reloads the page so
 * the server renders the real link (#103).
 *
 * A reload rather than a client-side swap on purpose. The download link is
 * deliberately a plain <a> pointing at a Route Handler, and the only way to
 * render it correctly is for the server to do it — a client that started
 * building the href itself would be re-creating the format/status decision this
 * whole change exists to stop the page from guessing.
 *
 * Stops on any non-pending terminal state, so a revoked or unavailable order
 * stops polling immediately instead of hammering the endpoint until the tab
 * closes.
 */
export default function OrderStatusPoller({ sessionId }: { sessionId: string }) {
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Backs off from 2s to 10s so a slow fulfillment does not keep the browser
    // asking, and stops entirely after ~2 minutes rather than polling forever
    // for an order that will never become ready.
    let delay = 2000;
    const deadline = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/order-status?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          // A 5xx from a KV read is transient; keep waiting until the deadline.
          if (res.status >= 500) return schedule();
          setGaveUp(true);
          return;
        }
        const data: unknown = await res.json();
        const state =
          data && typeof data === "object"
            ? (data as { state?: unknown }).state
            : undefined;
        if (state === "digital-pending") return schedule();
        // Any other known state is final: let the server render it.
        if (typeof state === "string") {
          window.location.reload();
          return;
        }
        setGaveUp(true);
      } catch {
        schedule();
      }
    };

    const schedule = () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(tick, delay);
      delay = Math.min(delay * 2, 10_000);
    };

    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId]);

  if (gaveUp) {
    return (
      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
        This is taking longer than usual. Refresh the page, or open the link in
        your Stripe receipt email.
      </p>
    );
  }
  return null;
}

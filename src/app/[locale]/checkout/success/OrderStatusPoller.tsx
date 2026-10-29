"use client";

import { useEffect, useState } from "react";
import {
  ORDER_VIEW_STATES,
  SESSION_ID_PARAM,
} from "@/domain/ordering/order-decision";

/**
 * Polls the order-status endpoint until the order reaches a final state, then
 * reloads the page so the server renders it.
 *
 * The sentence it gives up with is handed over as a prop: this is a client
 * component, and a copy it imported itself would carry every locale's words
 * to every browser that opened the page.
 */
export default function OrderStatusPoller({
  sessionId,
  timedOut,
}: {
  sessionId: string;
  /** The sentence shown when the deadline passes. */
  timedOut: string;
}) {
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let delay = 2000;
    const deadline = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/order-status?${SESSION_ID_PARAM}=${encodeURIComponent(sessionId)}`,
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
        // The pending state is named by the owner of the vocabulary, not
        // spelled here: the endpoint answers with a bare string, and a second
        // spelling of a state name is a second owner of it.
        if (state === ORDER_VIEW_STATES.digitalPending) return schedule();
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
        {timedOut}
      </p>
    );
  }
  return null;
}

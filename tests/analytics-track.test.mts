/**
 * The client side of the interaction beacon (#119).
 *
 * `src/analytics/track.ts` was the only runtime module in `src/` with no test:
 * the route's allowlist and the beacon component were both covered, and the
 * helper between them was not. What it does is worth pinning, because every
 * part of it is a promise about not breaking the page it runs on:
 *
 * - **it never runs during SSR.** The helper is called from render effects and
 *   click handlers, and a server render has no `window`; touching it there
 *   would throw where the caller has no way to catch it.
 * - **it never delays or fails a render.** The request is fire-and-forget:
 *   `keepalive` so a click that navigates does not cancel it, and both failure
 *   paths swallowed. A lost beacon is not a user-facing failure.
 * - **it sends the path, not the whole URL.** The route strips the query and
 *   the fragment, but only the path is worth recording, and a query string
 *   can carry a session id.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { track } from "../src/analytics/track.ts";

type FetchCall = { url: string; init: RequestInit };

/** A window with just the pathname, and a way to take it away again. */
function withWindow(pathname: string): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { location: { pathname } },
    configurable: true,
    writable: true,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  };
}

/** A fetch that records its calls and answers with the given behaviour. */
function withFetch(
  behaviour: "resolve" | "reject" | "throw",
): { calls: FetchCall[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (behaviour === "throw") throw new TypeError("fetch failed");
    if (behaviour === "reject") throw new TypeError("network down");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("track posts the event and the path to the beacon", () => {
  const restoreWindow = withWindow("/contact");
  const { calls, restore: restoreFetch } = withFetch("resolve");
  try {
    track("contact_open");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/e");
    assert.equal(calls[0]?.init.method, "POST");
    // keepalive is the whole reason the click that navigates does not cancel
    // the beacon on the way out.
    assert.equal(calls[0]?.init.keepalive, true);
    assert.deepEqual(
      JSON.parse(String(calls[0]?.init.body)),
      { event: "contact_open", path: "/contact" },
    );
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("track does nothing without a window, so an SSR render cannot throw", () => {
  const restoreWindow = withWindow("/contact");
  const { calls, restore: restoreFetch } = withFetch("resolve");
  try {
    restoreWindow();
    track("contact_open");
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test("a beacon that fails never reaches the caller", () => {
  const restoreWindow = withWindow("/prints/a-photo");
  try {
    for (const behaviour of ["reject", "throw"] as const) {
      const { calls, restore: restoreFetch } = withFetch(behaviour);
      try {
        // Neither a rejected request nor a synchronous throw may surface:
        // this is called from a click handler and a render effect.
        track("configurator_submit");
        assert.equal(calls.length, 1);
      } finally {
        restoreFetch();
      }
    }
  } finally {
    restoreWindow();
  }
});

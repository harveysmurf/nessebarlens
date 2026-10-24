/**
 * The one owner of the bounded Prodigi call.
 *
 * The rule under test is the one that decides whether a paid order is
 * retried or stranded: a call that hits our deadline is a timeout, and any
 * other network failure is Prodigi being unreachable. The four call sites used
 * to each write it, and the copy that answers a timeout like an ordinary
 * outage is the one that strands the order.
 *
 * The tests drive the real `fetch` seam rather than a copy of the rule, so a
 * helper that answered "server" for a timeout would fail here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { prodigiCall } from "../src/infrastructure/prodigi/prodigi-request.ts";

type Call = { url: string; init: RequestInit | undefined };

function withFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A signal that has already aborted, the way a hit deadline looks. */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

test("a call that answers carries the response through", async () => {
  const { calls, restore } = withFetch(() => new Response("{}", { status: 200 }));
  try {
    const call = await prodigiCall(
      "https://api.prodigi.com/v4.0/quotes",
      { method: "POST" },
      new AbortController().signal,
      "timed out",
    );

    assert.equal(call.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.prodigi.com/v4.0/quotes");
    assert.equal(calls[0]?.init?.method, "POST");
    if (call.ok) assert.equal(call.response.status, 200);
  } finally {
    restore();
  }
});

test("the deadline is the caller's own signal, and it reaches the request", async () => {
  const { calls, restore } = withFetch(() => new Response("{}", { status: 200 }));
  try {
    const controller = new AbortController();
    await prodigiCall(
      "https://api.prodigi.com/v4.0/quotes",
      {},
      controller.signal,
      "timed out",
    );

    assert.equal(calls[0]?.init?.signal, controller.signal);
  } finally {
    restore();
  }
});

test("a call that hits the deadline is a timeout, and says so in Prodigi's vocabulary", async () => {
  const { restore } = withFetch(() => {
    throw new Error("The operation was aborted");
  });
  try {
    const call = await prodigiCall(
      "https://api.prodigi.com/v4.0/quotes",
      {},
      abortedSignal(),
      "Prodigi quote timed out",
    );

    assert.equal(call.ok, false);
    if (!call.ok) {
      assert.equal(call.failure.kind, "timeout");
      assert.equal(call.failure.reason, "prodigi-timeout");
      assert.equal(call.failure.message, "Prodigi quote timed out");
    }
  } finally {
    restore();
  }
});

test("any other network failure is Prodigi being unreachable", async () => {
  const { restore } = withFetch(() => {
    throw new Error("fetch failed");
  });
  try {
    const call = await prodigiCall(
      "https://api.prodigi.com/v4.0/quotes",
      {},
      new AbortController().signal,
      "Prodigi quote timed out",
    );

    assert.equal(call.ok, false);
    if (!call.ok) {
      assert.equal(call.failure.kind, "server");
      assert.equal(call.failure.reason, "prodigi-unavailable");
      assert.equal(call.failure.message, "fetch failed");
    }
  } finally {
    restore();
  }
});

test("a failure that is not an Error still names the network", async () => {
  const { restore } = withFetch(() => {
    throw "offline";
  });
  try {
    const call = await prodigiCall(
      "https://api.prodigi.com/v4.0/quotes",
      {},
      new AbortController().signal,
      "Prodigi quote timed out",
    );

    assert.equal(call.ok, false);
    if (!call.ok) assert.equal(call.failure.message, "network-error");
  } finally {
    restore();
  }
});

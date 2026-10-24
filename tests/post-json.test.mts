/**
 * The one owner of "POST JSON to our own API".
 *
 * Four call sites used to write the method, the content type and the
 * serialisation themselves. The rule under test is the one they now share, so
 * these tests read the request the helper actually sends rather than a copy of
 * it: a request that lost its content type is refused by the API's JSON
 * reader, and the helper is the only place that writes it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { postJson } from "../src/infrastructure/http/post-json.ts";

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

const ok = (): Response => new Response("{}", { status: 200 });

test("a JSON post is a POST with the JSON content type and a JSON body", async () => {
  const { calls, restore } = withFetch(ok);
  try {
    await postJson("/api/contact", { name: "Ada" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/contact");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.init?.headers, {
      "Content-Type": "application/json",
    });
    assert.equal(String(calls[0]?.init?.body), '{"name":"Ada"}');
  } finally {
    restore();
  }
});

test("the body is serialised, so a caller cannot send a raw string by accident", async () => {
  const { calls, restore } = withFetch(ok);
  try {
    await postJson("/api/e", "contact_open");

    assert.equal(String(calls[0]?.init?.body), '"contact_open"');
  } finally {
    restore();
  }
});

test("an abort signal is passed through, so the caller can abandon the request", async () => {
  const { calls, restore } = withFetch(ok);
  try {
    const controller = new AbortController();
    await postJson("/api/quote", { size: "30x40" }, { signal: controller.signal });

    assert.equal(calls[0]?.init?.signal, controller.signal);
  } finally {
    restore();
  }
});

test("keepalive is passed through, so a beacon can outlive the page", async () => {
  const { calls, restore } = withFetch(ok);
  try {
    await postJson("/api/e", { event: "contact_open" }, { keepalive: true });

    assert.equal(calls[0]?.init?.keepalive, true);
  } finally {
    restore();
  }
});

test("a request with no options carries neither a signal nor keepalive", async () => {
  const { calls, restore } = withFetch(ok);
  try {
    await postJson("/api/checkout", { size: "30x40" });

    assert.equal(calls[0]?.init?.signal, undefined);
    assert.equal(calls[0]?.init?.keepalive, undefined);
  } finally {
    restore();
  }
});

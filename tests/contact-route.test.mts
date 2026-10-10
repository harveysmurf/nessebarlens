/**
 * POST /api/contact wiring (#293).
 *
 * The route is called the way Next calls it — a Request in, a Response out —
 * with readWorkerBindings swapped for a fake and globalThis.fetch replaced by a
 * scripted Transport. Validation, orchestration and mapping are covered in
 * contact.test.mts; what this file proves is the wiring: config 503s, the guard
 * order (no Resend call before Siteverify passes), the IP forwarding, and the
 * rate-limit binding.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

const FAKE = "buzz-test:fake-worker-bindings";

type Fake = {
  resendApiKey?: string;
  turnstileSecret?: string;
  contactRecipient?: string;
  contactRateLimiter?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  prodigiKeyConfigured: boolean;
};

const globals = globalThis as { __buzzBindings?: Fake };
const initial: Fake = { prodigiKeyConfigured: false };
globals.__buzzBindings = initial;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/infrastructure/cloudflare/worker-bindings") {
      return { url: FAKE, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === FAKE) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export async function readWorkerBindings() { return globalThis.__buzzBindings; }",
      };
    }
    return nextLoad(url, context);
  },
});

const SITE = "https://nessebarlens.com";
const route = await import("../src/app/api/contact/route.ts");

const CONFIGURED: Fake = {
  resendApiKey: "re_test_key",
  turnstileSecret: "turnstile-secret",
  contactRecipient: "simeon.babev@gmail.com",
  prodigiKeyConfigured: false,
};

const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  message: "Hello there",
  turnstileToken: "tok_123",
};

let snapshot: { bindings: unknown; fetch: typeof globalThis.fetch };

beforeEach(() => {
  snapshot = { bindings: globals.__buzzBindings, fetch: globalThis.fetch };
});

afterEach(() => {
  // Repair only: each test mutates the fake bindings and global fetch, and the
  // route reads the global at call time. Restoring here keeps one test's world
  // out of the next's without every test needing its own finally block.
  globals.__buzzBindings = snapshot.bindings;
  globalThis.fetch = snapshot.fetch;
});

function withBindings(next: Fake) {
  globals.__buzzBindings = next;
}

/** A fetch that plays a queue of responses and records each call. */
function scriptedFetch(
  responses: Array<Response | (() => Response | Promise<Response>)>,
): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return calls;
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/api/contact`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const siteverifyOk = () => new Response(JSON.stringify({ success: true }), { status: 200 });
const resendOk = () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });

test("contact: unparseable body is the canonical 400", async () => {
  withBindings(CONFIGURED);
  const response = await route.POST(
    new Request(`${SITE}/api/contact`, { method: "POST", body: "not json" }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { error: "Invalid JSON" });
});

test("contact: invalid fields return 400 with per-field errors and call no provider", async () => {
  withBindings(CONFIGURED);
  const calls = scriptedFetch([]);
  const response = await route.POST(jsonRequest({ ...VALID, email: "nope" }));
  assert.equal(response.status, 400);
  const payload = await body(response);
  assert.match(String(payload.error), /check the highlighted fields/i);
  assert.deepEqual(payload.fields, [
    { field: "email", message: "Please enter a valid email address." },
  ]);
  assert.equal(calls.length, 0);
});

test("contact: missing Turnstile secret, recipient or Resend key each answer 503", async () => {
  for (const missing of ["turnstileSecret", "contactRecipient", "resendApiKey"] as const) {
    withBindings({ ...CONFIGURED, [missing]: undefined });
    const calls = scriptedFetch([]);
    const response = await route.POST(jsonRequest(VALID));
    assert.equal(response.status, 503, `missing ${missing} must be 503`);
    assert.deepEqual(await body(response), { error: "Contact is not configured" });
    assert.equal(calls.length, 0);
  }
});

test("contact: a failed Siteverify rejects before any Resend call", async () => {
  withBindings(CONFIGURED);
  const calls = scriptedFetch([
    () => new Response(JSON.stringify({ success: false }), { status: 200 }),
  ]);
  const response = await route.POST(jsonRequest(VALID, { "cf-connecting-ip": "203.0.113.7" }));
  assert.equal(response.status, 400);
  assert.match(String((await body(response)).error), /couldn't verify/i);
  assert.equal(calls.length, 1, "only Siteverify is called");
  const params = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(params.get("remoteip"), "203.0.113.7");
});

test("contact: the happy path verifies then mails, with reply-to and no remoteip when absent", async () => {
  withBindings(CONFIGURED);
  const calls = scriptedFetch([siteverifyOk, resendOk]);
  const response = await route.POST(jsonRequest(VALID));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true });

  assert.equal(calls.length, 2);
  assert.equal(new URLSearchParams(String(calls[0]!.init.body)).has("remoteip"), false);
  const mail = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual(mail.to, ["simeon.babev@gmail.com"]);
  assert.equal(mail.reply_to, "ada@example.com");
});

test("contact: a Resend failure is reported as 502, not false success", async () => {
  withBindings(CONFIGURED);
  scriptedFetch([siteverifyOk, () => new Response("boom", { status: 500 })]);
  const response = await route.POST(jsonRequest(VALID));
  assert.equal(response.status, 502);
  assert.match(String((await body(response)).error), /could not be sent/i);
});

test("contact: the rate-limit binding sheds the request before any provider call", async () => {
  let limited = false;
  withBindings({
    ...CONFIGURED,
    contactRateLimiter: {
      limit: async () => {
        limited = true;
        return { success: false };
      },
    },
  });
  const calls = scriptedFetch([]);
  const response = await route.POST(jsonRequest(VALID, { "cf-connecting-ip": "203.0.113.7" }));
  assert.equal(response.status, 429);
  assert.equal(limited, true);
  assert.equal(calls.length, 0);
});

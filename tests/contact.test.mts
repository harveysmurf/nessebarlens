/**
 * Contact form (#293): validation, email copy, the two adapters, the
 * orchestration and the response mapping. The route's wiring is covered
 * separately in contact-route.test.mts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContactEmail,
  contactEmailError,
  parseContactMessage,
  CONTACT_EMAIL_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_NAME_MAX,
} from "../src/domain/contact/contact-message.ts";
import {
  createTurnstileVerifier,
  TURNSTILE_SITEVERIFY_URL,
} from "../src/infrastructure/turnstile/cloudflare-turnstile.ts";
import { createContactEmailSender } from "../src/infrastructure/contact/email-contact-message.ts";
import { submitContact } from "../src/application/contact/submit-contact.ts";
import {
  contactResponse,
  CONTACT_DELIVERY_FAILED_ERROR,
  CONTACT_INVALID_ERROR,
  CONTACT_RATE_LIMITED_ERROR,
  CONTACT_REJECTED_ERROR,
} from "../src/application/contact/contact-response.ts";
import { RESEND_EMAILS_URL, RESEND_FROM_ADDRESS, RESEND_TIMEOUT_MS } from "../src/domain/ordering/email.ts";
import { turnstileSiteKey } from "../src/infrastructure/config/config.ts";
import { isContactRateLimiter } from "../src/infrastructure/cloudflare/worker-bindings.ts";

const VALID = {
  name: "  Ada Lovelace ",
  email: " ada@example.com ",
  message: "  Hello there  ",
  turnstileToken: "  tok_123 ",
};

test("parseContactMessage trims and returns a valid message", () => {
  const result = parseContactMessage(VALID);
  assert.deepEqual(result, {
    ok: true,
    value: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      message: "Hello there",
      turnstileToken: "tok_123",
    },
  });
});

test("a non-object body reports every field as missing", () => {
  for (const raw of [null, "nope", ["x"], 42, undefined]) {
    const result = parseContactMessage(raw);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.deepEqual(
      result.errors.map((e) => e.field),
      ["name", "email", "message", "turnstileToken"],
    );
  }
});

test("each field is validated independently, and all errors are returned at once", () => {
  const result = parseContactMessage({
    name: "",
    email: "not-an-email",
    message: "",
    turnstileToken: "",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.errors,
    [
      { field: "name", message: "Please enter your name." },
      { field: "email", message: "Please enter a valid email address." },
      { field: "message", message: "Please enter a message." },
      { field: "turnstileToken", message: "Please complete the anti-spam check." },
    ],
  );
});

test("length limits are enforced on name, email and message", () => {
  const long = "x".repeat(CONTACT_NAME_MAX + 1);
  const nameResult = parseContactMessage({ ...VALID, name: long });
  assert.deepEqual(nameResult, {
    ok: false,
    errors: [{ field: "name", message: "That name is too long." }],
  });

  const emailLocal = "x".repeat(CONTACT_EMAIL_MAX + 5);
  const emailResult = parseContactMessage({ ...VALID, email: `${emailLocal}@example.com` });
  assert.deepEqual(emailResult, {
    ok: false,
    errors: [{ field: "email", message: "That email address is too long." }],
  });

  const messageResult = parseContactMessage({
    ...VALID,
    message: "m".repeat(CONTACT_MESSAGE_MAX + 1),
  });
  assert.deepEqual(messageResult, {
    ok: false,
    errors: [{ field: "message", message: "That message is too long." }],
  });
});

test("contactEmailError mirrors the server's email rule", () => {
  assert.equal(contactEmailError(""), "Please enter your email address.");
  assert.equal(
    contactEmailError(`${"x".repeat(CONTACT_EMAIL_MAX + 1)}@e.com`),
    "That email address is too long.",
  );
  assert.equal(contactEmailError("no-at-sign"), "Please enter a valid email address.");
  assert.equal(contactEmailError("a@b"), "Please enter a valid email address.");
  assert.equal(contactEmailError("a b@example.com"), "Please enter a valid email address.");
  assert.equal(contactEmailError("ok@example.com"), null);
});

test("buildContactEmail puts the visitor facts in the body and collapses newlines in the name", () => {
  const { subject, text } = buildContactEmail({
    name: "Ada\nLovelace",
    email: "ada@example.com",
    message: "Line one\nLine two",
    turnstileToken: "tok",
  });
  assert.equal(subject, "Website contact from Ada Lovelace");
  assert.match(text, /Name: Ada Lovelace/);
  assert.match(text, /Email: ada@example\.com/);
  assert.match(text, /Line one\nLine two/);
});

test("Turnstile verifier posts the token and accepts success", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const verifier = createTurnstileVerifier({
    secretKey: "secret-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });
  const result = await verifier.verify({ token: "tok", remoteIp: "203.0.113.7" });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0]!.url, TURNSTILE_SITEVERIFY_URL);
  const params = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(params.get("secret"), "secret-key");
  assert.equal(params.get("response"), "tok");
  assert.equal(params.get("remoteip"), "203.0.113.7");
});

test("Turnstile verifier omits remoteip when the caller has none, and fails closed", async () => {
  let body = "";
  const verifier = createTurnstileVerifier({
    secretKey: "secret-key",
    fetchImpl: async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), {
        status: 200,
      });
    },
  });
  const result = await verifier.verify({ token: "tok" });
  assert.deepEqual(result, { ok: false, reason: "siteverify-failed" });
  assert.equal(new URLSearchParams(body).has("remoteip"), false);
});

test("Turnstile verifier fails closed on a non-2xx, a malformed body and a non-object payload", async () => {
  const http = createTurnstileVerifier({
    secretKey: "s",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.deepEqual(await http.verify({ token: "t" }), {
    ok: false,
    reason: "siteverify-http-500",
  });

  const malformed = createTurnstileVerifier({
    secretKey: "s",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });
  assert.deepEqual(await malformed.verify({ token: "t" }), {
    ok: false,
    reason: "siteverify-malformed",
  });

  const scalar = createTurnstileVerifier({
    secretKey: "s",
    fetchImpl: async () => new Response(JSON.stringify("true"), { status: 200 }),
  });
  assert.deepEqual(await scalar.verify({ token: "t" }), {
    ok: false,
    reason: "siteverify-failed",
  });
});

test("Turnstile verifier classifies a network error and a timeout", async () => {
  const network = createTurnstileVerifier({
    secretKey: "s",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(await network.verify({ token: "t" }), {
    ok: false,
    reason: "siteverify-network-error",
  });

  const verifier = createTurnstileVerifier({
    secretKey: "s",
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
      return new Response("{}");
    },
  });
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    assert.equal(ms, RESEND_TIMEOUT_MS);
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }) as typeof AbortSignal.timeout;
  try {
    assert.deepEqual(await verifier.verify({ token: "t" }), {
      ok: false,
      reason: "siteverify-timeout",
    });
  } finally {
    AbortSignal.timeout = original;
  }
});

test("contact email sender posts to Resend with reply-to and the sender domain", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sender = createContactEmailSender({
    apiKey: "re_test_key",
    to: "simeon.babev@gmail.com",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    },
  });
  const result = await sender.send({
    replyTo: "visitor@example.com",
    subject: "Website contact",
    text: "Body",
  });
  assert.deepEqual(result, { ok: true, message: "sent" });
  assert.equal(calls[0]!.url, RESEND_EMAILS_URL);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.from, RESEND_FROM_ADDRESS);
  assert.deepEqual(body.to, ["simeon.babev@gmail.com"]);
  assert.equal(body.reply_to, "visitor@example.com");
});

test("contact email sender honours a from override and reports failures without throwing", async () => {
  const overridden = createContactEmailSender({
    apiKey: "re_test_key",
    to: "ops@example.com",
    from: "Nessebar Lens <contact@nessebarlens.com>",
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).from, "Nessebar Lens <contact@nessebarlens.com>");
      return new Response("quota exceeded", { status: 429 });
    },
  });
  const failed = await overridden.send({ replyTo: "v@e.com", subject: "s", text: "t" });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Resend HTTP 429/);
  assert.match(failed.message, /quota exceeded/);

  const unreadable = createContactEmailSender({
    apiKey: "k",
    to: "ops@example.com",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
        { status: 502 },
      ),
  });
  const bare = await unreadable.send({ replyTo: "v@e.com", subject: "s", text: "t" });
  assert.equal(bare.message, "Resend HTTP 502");

  const thrown = createContactEmailSender({
    apiKey: "k",
    to: "ops@example.com",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal((await thrown.send({ replyTo: "v@e.com", subject: "s", text: "t" })).message, "ECONNREFUSED");

  const nonError = createContactEmailSender({
    apiKey: "k",
    to: "ops@example.com",
    fetchImpl: async () => {
      throw "socket hang up";
    },
  });
  assert.equal(
    (await nonError.send({ replyTo: "v@e.com", subject: "s", text: "t" })).message,
    "resend-network-error",
  );
});

test("contact email sender classifies a timeout", async () => {
  const sender = createContactEmailSender({
    apiKey: "k",
    to: "ops@example.com",
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
      return new Response("{}");
    },
  });
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (() => {
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }) as typeof AbortSignal.timeout;
  try {
    const result = await sender.send({ replyTo: "v@e.com", subject: "s", text: "t" });
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
  } finally {
    AbortSignal.timeout = original;
  }
});

const okVerifier = { verify: async () => ({ ok: true as const }) };
const okSender = { send: async () => ({ ok: true, message: "sent" }) };
const rejectedVerifier = { verify: async () => ({ ok: false as const, reason: "siteverify-failed" }) };
const failingSender = { send: async () => ({ ok: false, message: "Resend HTTP 500" }) };

test("submitContact returns ok and sends after verification", async () => {
  let sent: { replyTo: string; subject: string } | null = null;
  const outcome = await submitContact(
    VALID,
    { rateLimitKey: "ip", remoteIp: "ip" },
    {
      verifyTurnstile: okVerifier,
      sendEmail: {
        send: async (mail) => {
          sent = mail;
          return { ok: true, message: "sent" };
        },
      },
    },
  );
  assert.deepEqual(outcome, { kind: "ok" });
  assert.equal(sent?.replyTo, "ada@example.com");
  assert.match(sent?.subject ?? "", /Ada Lovelace/);
});

test("submitContact returns invalid before verifying or sending", async () => {
  let verified = false;
  const outcome = await submitContact(
    { ...VALID, email: "bad" },
    { rateLimitKey: "ip" },
    {
      verifyTurnstile: {
        verify: async () => {
          verified = true;
          return { ok: true as const };
        },
      },
      sendEmail: okSender,
    },
  );
  assert.equal(outcome.kind, "invalid");
  assert.equal(verified, false);
});

test("submitContact rejects when Turnstile fails, and never sends", async () => {
  let sent = false;
  const outcome = await submitContact(
    VALID,
    { rateLimitKey: "ip" },
    {
      verifyTurnstile: rejectedVerifier,
      sendEmail: {
        send: async () => {
          sent = true;
          return { ok: true, message: "sent" };
        },
      },
    },
  );
  assert.deepEqual(outcome, { kind: "rejected", reason: "siteverify-failed" });
  assert.equal(sent, false);
});

test("submitContact reports a delivery failure", async () => {
  const outcome = await submitContact(VALID, { rateLimitKey: "ip" }, {
    verifyTurnstile: okVerifier,
    sendEmail: failingSender,
  });
  assert.deepEqual(outcome, { kind: "delivery-failed", detail: "Resend HTTP 500" });
});

test("submitContact rate-limits before any validation when the limiter says no", async () => {
  let parsed = false;
  const outcome = await submitContact(
    { ...VALID, name: "" },
    { rateLimitKey: "203.0.113.9" },
    {
      rateLimit: {
        limit: async (options) => {
          assert.equal(options.key, "203.0.113.9");
          return { success: false };
        },
      },
      verifyTurnstile: okVerifier,
      sendEmail: {
        send: async () => {
          parsed = true;
          return { ok: true, message: "sent" };
        },
      },
    },
  );
  assert.deepEqual(outcome, { kind: "rate-limited" });
  assert.equal(parsed, false);
});

test("submitContact proceeds when the limiter allows", async () => {
  let calls = 0;
  const outcome = await submitContact(VALID, { rateLimitKey: "ip" }, {
    rateLimit: {
      limit: async () => {
        calls += 1;
        return { success: true };
      },
    },
    verifyTurnstile: okVerifier,
    sendEmail: okSender,
  });
  assert.deepEqual(outcome, { kind: "ok" });
  assert.equal(calls, 1);
});

test("contactResponse maps every outcome to status and copy", () => {
  assert.deepEqual(contactResponse({ kind: "ok" }), { status: 200, body: { ok: true } });
  assert.deepEqual(
    contactResponse({ kind: "invalid", errors: [{ field: "name", message: "nope" }] }),
    {
      status: 400,
      body: { error: CONTACT_INVALID_ERROR, fields: [{ field: "name", message: "nope" }] },
    },
  );
  assert.deepEqual(contactResponse({ kind: "rate-limited" }), {
    status: 429,
    body: { error: CONTACT_RATE_LIMITED_ERROR },
  });
  assert.deepEqual(contactResponse({ kind: "rejected", reason: "x" }), {
    status: 400,
    body: { error: CONTACT_REJECTED_ERROR },
  });
  assert.deepEqual(contactResponse({ kind: "delivery-failed", detail: "x" }), {
    status: 502,
    body: { error: CONTACT_DELIVERY_FAILED_ERROR },
  });
});

test("turnstileSiteKey reads the public key from the given env", () => {
  assert.equal(turnstileSiteKey({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: " 0xKEY " }), "0xKEY");
  assert.equal(turnstileSiteKey({}), undefined);
});

test("isContactRateLimiter accepts only an object exposing limit", () => {
  assert.equal(isContactRateLimiter({ limit: () => {} }), true);
  assert.equal(isContactRateLimiter({}), false);
  assert.equal(isContactRateLimiter(null), false);
  assert.equal(isContactRateLimiter("limit"), false);
});

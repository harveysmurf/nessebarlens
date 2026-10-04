/**
 * Resend sender + email copy (#117).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createResendSender,
  isEmailKind,
  RESEND_EMAILS_URL,
  RESEND_FROM_ADDRESS,
  RESEND_TIMEOUT_MS,
  sendEmailFromApiKey,
} from "../src/lib/email.ts";
import { emailCopyFor } from "../src/lib/email-copy.ts";
import { orderReference } from "../src/lib/order-reference.ts";
import { parseOrderRecord } from "../src/lib/order-decision.ts";

const SESSION = "cs_test_abcdefgh";

test("Resend sender posts to the documented URL with auth and idempotency key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
  };
  const send = createResendSender({ apiKey: "re_test_key", fetchImpl });
  const result = await send({
    to: "buyer@example.com",
    kind: "order-confirmation",
    subject: "Hi",
    text: "Body",
    sessionId: SESSION,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, RESEND_EMAILS_URL);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  assert.equal(headers["Idempotency-Key"], `${SESSION}:order-confirmation`);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.from, RESEND_FROM_ADDRESS);
  assert.deepEqual(body.to, ["buyer@example.com"]);
  assert.equal(body.subject, "Hi");
  assert.equal(body.text, "Body");
});

test("Resend non-2xx is reported, not thrown", async () => {
  const send = createResendSender({
    apiKey: "re_test_key",
    fetchImpl: async () =>
      new Response("quota exceeded", { status: 429 }),
  });
  const result = await send({
    to: "buyer@example.com",
    kind: "print-shipped",
    subject: "Shipped",
    text: "Gone",
    sessionId: SESSION,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Resend HTTP 429/);
  assert.match(result.message, /quota exceeded/);
});

test("Resend timeout is classified via the shared abort idiom", async () => {
  const send = createResendSender({
    apiKey: "re_test_key",
    fetchImpl: async (_url, init) => {
      // Honour the signal the sender attached so isProdigiTimeout sees it.
      const signal = init?.signal;
      if (signal) {
        await new Promise<void>((_, reject) => {
          if (signal.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          });
        });
      }
      return new Response("ok");
    },
  });
  // Force an already-aborted signal by stubbing AbortSignal.timeout briefly.
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    assert.equal(ms, RESEND_TIMEOUT_MS);
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }) as typeof AbortSignal.timeout;
  try {
    const result = await send({
      to: "buyer@example.com",
      kind: "order-unfulfilled",
      subject: "Sorry",
      text: "Nope",
      sessionId: SESSION,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
  } finally {
    AbortSignal.timeout = original;
  }
});

test("a thrown non-Error from fetch is reported, not propagated", async () => {
  // A `fetch` polyfill or a proxy that rejects with a bare value is not ours
  // to assume about. The message must still be a string the caller logs.
  const send = createResendSender({
    apiKey: "re_test_key",
    fetchImpl: async () => {
      throw "socket hang up";
    },
  });
  const result = await send({
    to: "buyer@example.com",
    kind: "order-confirmation",
    subject: "Hi",
    text: "Body",
    sessionId: SESSION,
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "resend-network-error");
});

test("an Error thrown by fetch keeps its message", async () => {
  const send = createResendSender({
    apiKey: "re_test_key",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const result = await send({
    to: "buyer@example.com",
    kind: "order-confirmation",
    subject: "Hi",
    text: "Body",
    sessionId: SESSION,
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "ECONNREFUSED");
});

test("a non-2xx with an unreadable body still names the status", async () => {
  const send = createResendSender({
    apiKey: "re_test_key",
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
  const result = await send({
    to: "buyer@example.com",
    kind: "print-shipped",
    subject: "Shipped",
    text: "Gone",
    sessionId: SESSION,
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "Resend HTTP 502");
});

test("sendEmailFromApiKey is undefined when the key is unset", () => {
  assert.equal(sendEmailFromApiKey(undefined), undefined);
  assert.equal(sendEmailFromApiKey(""), undefined);
  assert.ok(sendEmailFromApiKey("re_live"));
});

test("isEmailKind accepts exactly the three kinds", () => {
  for (const kind of ["order-confirmation", "print-shipped", "order-unfulfilled"]) {
    assert.equal(isEmailKind(kind), true, kind);
  }
  for (const other of ["", "shipped", "ORDER-CONFIRMATION", null, 7, {}]) {
    assert.equal(isEmailKind(other), false, String(other));
  }
});

test("confirmation copy links the success page, never a token or Prodigi id", () => {
  const copy = emailCopyFor({
    kind: "order-confirmation",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
  });
  assert.match(copy.text, /https:\/\/nessebarlens\.com\/checkout\/success\?session_id=cs_test_abcdefgh/);
  assert.equal(copy.text.includes("prints/"), false);
  assert.equal(copy.text.includes("ord_"), false);
  assert.equal(copy.text.includes("token="), false);
});

test("shipped copy includes the tracking number", () => {
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    trackingNumber: "1Z999",
    carrier: "DHL",
    trackingUrl: "https://track.example/1Z999",
  });
  assert.match(copy.text, /1Z999/);
  assert.match(copy.text, /DHL/);
  assert.match(copy.text, /https:\/\/track\.example\/1Z999/);
});

test("unfulfilled copy names the session as a reference and no internal id", () => {
  const copy = emailCopyFor({
    kind: "order-unfulfilled",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
  });
  assert.equal(copy.subject, "We could not complete your Nessebar Lens order");
  assert.match(copy.text, /Reference: ABCDEFGH\b/);
  assert.equal(copy.text.includes("cs_test_"), false, "the raw session id is not the reference");
  assert.equal(copy.text.includes("ord_"), false);
  assert.equal(copy.text.includes("assetUrl"), false);
});

test("shipped copy with no tracking details says so instead of empty lines", () => {
  // Prodigi can mark a shipment Shipped before a carrier posts tracking. An
  // empty "Tracking number:" line reads as a bug to the customer, so the copy
  // has to have a third shape rather than a conditional field.
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    trackingNumber: "   ",
    carrier: "",
    trackingUrl: undefined,
  });
  assert.match(copy.text, /Your carrier will provide tracking details separately\./);
  assert.equal(/Tracking number:/.test(copy.text), false);
  assert.equal(/Carrier:/.test(copy.text), false);
});

test("parseOrderRecord accepts a pre-#117 record with no shipments/emailsSent", () => {
  const legacy = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 30,
    amountTotal: 3000,
    currency: "eur",
    reason: null,
    masterKey: "prints/dawn.jpg",
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-02T00:00:00.000Z",
    recipient: null,
  };
  const parsed = parseOrderRecord(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.deepEqual(parsed.shipments, []);
  assert.deepEqual(parsed.emailsSent, []);
});

test("parseOrderRecord defaults hostile shipments/emailsSent rather than rejecting", () => {
  const paid = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 30,
    amountTotal: 3000,
    currency: "eur",
    reason: null,
    masterKey: "prints/dawn.jpg",
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-02T00:00:00.000Z",
    recipient: null,
    shipments: "not-an-array",
    emailsSent: { kind: "order-confirmation" },
  };
  const parsed = parseOrderRecord(JSON.stringify(paid));
  assert.ok(parsed, "hostile shipments/emailsSent must not reject a paid order");
  assert.deepEqual(parsed.shipments, []);
  assert.deepEqual(parsed.emailsSent, []);
});

test("every email prints the same short reference the success page prints", () => {
  const ref = orderReference(SESSION);
  assert.equal(ref, "ABCDEFGH");
  assert.equal(orderReference("cs_test_a1Zh499zOjUOk1s1"), "OJUOK1S1");
  for (const kind of ["order-confirmation", "print-shipped", "order-unfulfilled"] as const) {
    const copy = emailCopyFor({ kind, sessionId: SESSION, siteUrl: "https://nessebarlens.com" });
    assert.match(copy.text, new RegExp(`Order reference: ${ref}\\b|Reference: ${ref}\\b`), kind);
  }
});

test("unfulfilled copy does not contradict the success page", () => {
  const copy = emailCopyFor({
    kind: "order-unfulfilled",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
  });
  assert.doesNotMatch(copy.text, /being produced/i);
});

/**
 * Resend sender + email copy (#117).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createResendSender,
  RESEND_EMAILS_URL,
  RESEND_FROM_ADDRESS,
  RESEND_TIMEOUT_MS,
  sendEmailFromApiKey,
} from "../src/lib/email.ts";
import { emailCopyFor } from "../src/lib/email-copy.ts";
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

test("sendEmailFromApiKey is undefined when the key is unset", () => {
  assert.equal(sendEmailFromApiKey(undefined), undefined);
  assert.equal(sendEmailFromApiKey(""), undefined);
  assert.ok(sendEmailFromApiKey("re_live"));
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

/**
 * Prodigi CloudEvent callback (#117).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  handleProdigiCallback,
  parseProdigiCloudEvent,
  shipmentsFromProdigiOrder,
  type FetchProdigiOrder,
} from "../src/lib/prodigi-callback.ts";
import { parseOrderRecord, type OrderRecord } from "../src/lib/order-decision.ts";
import { buildProdigiOrderBody, type OrderRecipient } from "../src/lib/prodigi-order.ts";
import type { SendEmail } from "../src/lib/email.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { d1OrdersStore } from "../src/lib/orders-d1.ts";
import { fakeD1 } from "./fake-d1.mts";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

const SESSION = "cs_test_abcdefgh";
const PRODIGI_ID = "ord_abc123xyz";
const NOW = "2026-10-03T12:00:00.000Z";
const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

function paidPhysical(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    kind: "physical",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: null,
    masterKey: null,
    recipient: RECIPIENT,
    prodigiOrderId: PRODIGI_ID,
    prodigiStage: "InProgress",
    assetUrl: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=" + "a".repeat(64),
    updatedAt: NOW,
    createdAt: NOW,
    attempts: 1,
    shipments: [],
    emailsSent: [],
    ...overrides,
  };
}

function cloudEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    specversion: "1.0",
    type: "com.prodigi.order.status.stage.changed#InProgress",
    source: "/v4.0/orders",
    id: "evt_test_001",
    time: NOW,
    datacontenttype: "application/json",
    subject: PRODIGI_ID,
    data: {
      order: {
        id: PRODIGI_ID,
        status: { stage: "HostileStageFromCallback" },
      },
    },
    ...overrides,
  });
}

function fetchOk(stage: string, shipments: unknown[] = []): FetchProdigiOrder {
  return async (orderId) => {
    assert.equal(orderId, PRODIGI_ID);
    return {
      ok: true,
      value: {
        orderId: PRODIGI_ID,
        merchantReference: SESSION,
        stage,
        shipments: shipmentsFromProdigiOrder({ shipments }),
      },
    };
  };
}

test("both documented data shapes parse; missing id/subject/specversion are rejected", () => {
  const nested = parseProdigiCloudEvent(
    JSON.stringify({
      specversion: "1.0",
      id: "evt_1",
      subject: PRODIGI_ID,
      data: { order: { id: PRODIGI_ID, status: { stage: "InProgress" } } },
    }),
  );
  assert.equal(nested.ok, true);

  const flat = parseProdigiCloudEvent(
    JSON.stringify({
      specversion: "1.0",
      id: "evt_2",
      subject: PRODIGI_ID,
      data: { id: PRODIGI_ID, status: { stage: "Complete" } },
    }),
  );
  assert.equal(flat.ok, true);

  for (const bad of [
    { id: "evt_x", subject: PRODIGI_ID },
    { specversion: "1.0", subject: PRODIGI_ID },
    { specversion: "1.0", id: "evt_x" },
    { specversion: "1.0", id: "", subject: PRODIGI_ID },
    "not-json",
  ]) {
    const raw = typeof bad === "string" ? bad : JSON.stringify(bad);
    const parsed = parseProdigiCloudEvent(raw);
    assert.equal(parsed.ok, false, raw);
  }
});

test("malformed CloudEvent is 400, not 500", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const result = await handleProdigiCallback({
    rawBody: '{"specversion":"1.0"}',
    store,
    now: NOW,
    fetchOrder: fetchOk("Complete"),
  });
  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "missing-id");
});

test("duplicate CloudEvent id answers 200 and does not re-write or re-send", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const sent: string[] = [];
  const sendEmail: SendEmail = async (mail) => {
    sent.push(mail.kind);
    return { ok: true, message: "sent" };
  };
  const fetchOrder = fetchOk("Complete", [
    {
      status: "Shipped",
      carrier: { name: "DHL" },
      tracking: { number: "1Z999", url: "https://track.example/1Z999" },
    },
  ]);

  const first = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store,
    sendEmail,
    fetchOrder,
    now: NOW,
  });
  assert.equal(first.httpStatus, 200);
  assert.equal(sent.length, 1);

  const putsBefore = store.orderPuts.length;
  const second = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store,
    sendEmail,
    fetchOrder,
    now: "2026-10-03T13:00:00.000Z",
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(sent.length, 1, "second delivery must not re-send");
  assert.equal(store.orderPuts.length, putsBefore, "second delivery must not re-write");
});

test("unknown subject ⇒ 200 + logged + no store write", async () => {
  const store = memoryOrdersStore();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    const result = await handleProdigiCallback({
      rawBody: cloudEvent({ subject: "ord_unknown_zzzz" }),
      store,
      now: NOW,
      fetchOrder: async () => ({
        ok: true,
        value: {
          orderId: "ord_unknown_zzzz",
          merchantReference: "cs_test_notours0000000001",
          stage: "Complete",
          shipments: [],
        },
      }),
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.ignored, "unknown-order");
    assert.equal(store.orderPuts.length, 0);
    assert.ok(lines.some((l) => l.includes("prodigi.callback.unknown-order")));
  } finally {
    console.error = original;
  }
});

test("stage + shipments persist from the fetch, not the hostile callback body", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  await handleProdigiCallback({
    rawBody: cloudEvent(),
    store,
    now: NOW,
    fetchOrder: fetchOk("Complete", [
      {
        status: "Shipped",
        carrier: { name: "DHL" },
        tracking: { number: "TRACK-FROM-FETCH", url: "https://track.example/x" },
      },
    ]),
  });
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(record.prodigiStage, "Complete");
  assert.equal(record.prodigiStage !== "HostileStageFromCallback", true);
  assert.equal(record.shipments[0]?.trackingNumber, "TRACK-FROM-FETCH");
});

test("a lost transitionOrder lock ⇒ 200 duplicate, no email", async () => {
  // The memory fake stores attempts inside the JSON, so simulate a lost lock
  // by making transitionOrder always return false after a successful claim.
  const sent: string[] = [];
  const base = memoryOrdersStore();
  await base.putOrder(paidPhysical());
  const locked = {
    ...base,
    async transitionOrder() {
      return false;
    },
    async claimProdigiCallback(eventId: string) {
      return base.claimProdigiCallback(eventId);
    },
  };
  const result = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store: locked,
    sendEmail: async (mail) => {
      sent.push(mail.kind);
      return { ok: true, message: "sent" };
    },
    fetchOrder: fetchOk("Complete", [
      {
        status: "Shipped",
        carrier: { name: "DHL" },
        tracking: { number: "1Z999", url: "https://track.example/1Z999" },
      },
    ]),
    now: NOW,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.duplicate, true);
  assert.equal(sent.length, 0);
});

test("shipped email sent once; tracking number appears; second callback does not re-send", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const mails: Array<{ kind: string; text: string }> = [];
  const sendEmail: SendEmail = async (mail) => {
    mails.push({ kind: mail.kind, text: mail.text });
    return { ok: true, message: "sent" };
  };
  const fetchOrder = fetchOk("Complete", [
    {
      status: "Shipped",
      carrier: { name: "DHL" },
      tracking: { number: "1Z999ABC", url: "https://track.example/1Z999ABC" },
    },
  ]);

  await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_ship_1" }),
    store,
    sendEmail,
    fetchOrder,
    now: NOW,
  });
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.kind, "print-shipped");
  assert.match(mails[0]!.text, /1Z999ABC/);

  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.ok(record.emailsSent.includes("print-shipped"));

  await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_ship_2" }),
    store,
    sendEmail,
    fetchOrder,
    now: "2026-10-03T14:00:00.000Z",
  });
  assert.equal(mails.length, 1, "emailsSent claim must block a second send");
});

test("Prodigi fetch failure ⇒ 5xx and no partial write", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const before = await store.getOrder(SESSION);
  const result = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store,
    now: NOW,
    fetchOrder: async () => ({
      ok: false,
      message: "Prodigi fetch HTTP 503",
      status: 503,
    }),
  });
  assert.equal(result.httpStatus, 500);
  assert.equal(await store.getOrder(SESSION), before);
  assert.equal(store.prodigiCallbacks.size, 0, "failed fetch must not claim the event");
});

test("D1 claimProdigiCallback is true once then false", async () => {
  const db = fakeD1();
  const store = d1OrdersStore(db as never);
  assert.equal(await store.claimProdigiCallback("evt_d1_1"), true);
  assert.equal(await store.claimProdigiCallback("evt_d1_1"), false);
});

test("order creation body includes same-origin callbackUrl", () => {
  const body = buildProdigiOrderBody({
    sessionId: SESSION,
    photoSlug: "dawn",
    format: "giclee",
    size: "50x70",
    frame: null,
    recipient: RECIPIENT,
  });
  assert.equal(body.callbackUrl, "https://nessebarlens.com/api/webhooks/prodigi");
  assert.equal(
    new URL(body.callbackUrl).origin,
    "https://nessebarlens.com",
  );
});

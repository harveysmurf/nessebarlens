/**
 * Prodigi CloudEvent callback (#117).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchProdigiOrder,
  handleProdigiCallback,
  parseProdigiCloudEvent,
  shipmentsFromProdigiOrder,
  type FetchProdigiOrder,
} from "../src/lib/prodigi-callback.ts";
import { PRODIGI_ORDER_TIMEOUT_MS } from "../src/lib/prodigi-config.ts";
import { parseOrderRecord, type OrderRecord } from "../src/lib/order-decision.ts";
import { buildProdigiOrderBody, type OrderRecipient } from "../src/lib/prodigi-order.ts";
import type { SendEmail } from "../src/lib/email.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { d1OrdersStore } from "../src/lib/orders-d1.ts";
import { sqliteD1 } from "./sqlite-d1.mts";

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
  const db = sqliteD1();
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
    webhookToken: "tok",
  });
  assert.equal(
    body.callbackUrl,
    "https://nessebarlens.com/api/webhooks/prodigi?token=tok",
  );
  assert.equal(
    new URL(body.callbackUrl!).origin,
    "https://nessebarlens.com",
  );
});

/* --- the live GET -------------------------------------------------------
   Every test above injects `fetchOrder`, which means the real one was never
   executed: the mapping from Prodigi's JSON onto the fields we persist, and
   every failure it has to report, were untested. Those failures are the ones
   that decide whether Prodigi gets a 5xx and retries or a 200 and gives up, so
   they are pinned here against a stubbed global fetch. */

type LiveCase = {
  response?: Response;
  throws?: unknown;
  env?: Record<string, string>;
  orderId?: string;
};

async function liveFetch(input: LiveCase) {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (input.throws !== undefined) throw input.throws;
    return input.response as Response;
  }) as typeof fetch;
  if (input.env) {
    for (const [k, v] of Object.entries(input.env)) process.env[k] = v;
  }
  try {
    const result = await fetchProdigiOrder(input.orderId ?? PRODIGI_ID);
    return { result, calls };
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  }
}

const LIVE_ENV = {
  PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
  PRODIGI_SANDBOX_API_KEY: "sandbox-key-for-callback-tests",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("live fetch maps a Prodigi order onto the fields we persist", async () => {
  const { result, calls } = await liveFetch({
    env: LIVE_ENV,
    response: json({
      outcome: "SUCCESS",
      order: {
        id: PRODIGI_ID,
        merchantReference: SESSION,
        status: {
          stage: "Complete",
          issues: [{ errorCode: "ASSET_NOT_FOUND" }],
        },
        shipments: [
          {
            status: "Shipped",
            carrier: { name: "DHL", service: "Express" },
            tracking: { number: "1Z999", url: "https://track.example/1Z999" },
          },
        ],
      },
    }),
  });
  assert.deepEqual(calls, [
    `https://api.sandbox.prodigi.com/v4.0/orders/${PRODIGI_ID}`,
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.orderId, PRODIGI_ID);
  assert.equal(result.value.merchantReference, SESSION);
  assert.equal(result.value.stage, "Complete");
  assert.equal(result.value.shipments.length, 1);
  assert.equal(result.value.shipments[0]!.trackingNumber, "1Z999");
  // `issues` and every other status detail are diagnostic. We persist stage and
  // shipments only, so an added Prodigi field cannot leak into the record.
  assert.equal(JSON.stringify(result.value).includes("ASSET_NOT_FOUND"), false);
});

test("live fetch refuses an unsafe order id before any network call", async () => {
  // The id reaches us from an unauthenticated-ish JSON field and lands in a
  // URL. isSafeProdigiOrderId is the only thing between the two.
  const { result, calls } = await liveFetch({
    env: LIVE_ENV,
    orderId: "../../v4.0/orders/other-secret",
    response: json({ order: { id: PRODIGI_ID } }),
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "no request may be made for an unsafe id");
  if (result.ok) return;
  assert.equal(result.message, "unsafe Prodigi order id");
});

test("live fetch reports an unconfigured deployment, not a network failure", async () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return json({});
  }) as typeof fetch;
  try {
    delete process.env.PRODIGI_API_BASE;
    delete process.env.PRODIGI_SANDBOX_API_KEY;
    delete process.env.PRODIGI_LIVE_API_KEY;
    const result = await fetchProdigiOrder(PRODIGI_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRODIGI_API_BASE/);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  }
});

test("live fetch reports a timeout as retryable and keeps the status null", async () => {
  // A timeout must not be confused with Prodigi saying 4xx: the caller
  // answers 5xx for both, but the log is how a human tells them apart.
  const savedTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    assert.equal(ms, PRODIGI_ORDER_TIMEOUT_MS);
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }) as typeof AbortSignal.timeout;
  try {
    const { result } = await liveFetch({
      env: LIVE_ENV,
      throws: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /timed out/);
    assert.equal(result.status, null);
  } finally {
    AbortSignal.timeout = savedTimeout;
  }
});

test("live fetch reports a non-Error network throw as a network error", async () => {
  const { result } = await liveFetch({
    env: LIVE_ENV,
    throws: "ECONNRESET",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.message, "network-error");
});

test("live fetch reports an HTTP failure with Prodigi's status so a 404 is distinguishable", async () => {
  const { result } = await liveFetch({
    env: LIVE_ENV,
    response: new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /Prodigi fetch HTTP 404/);
  assert.equal(result.status, 404);
});

test("live fetch rejects a 200 whose body is not JSON, or has no usable order", async () => {
  const notJson = await liveFetch({
    env: LIVE_ENV,
    response: new Response("<html>gateway</html>", { status: 200 }),
  });
  assert.equal(notJson.result.ok, false);
  if (!notJson.result.ok) {
    assert.equal(notJson.result.message, "Prodigi fetch invalid JSON");
  }

  const noOrder = await liveFetch({ env: LIVE_ENV, response: json({ outcome: "SUCCESS" }) });
  assert.equal(noOrder.result.ok, false);
  if (!noOrder.result.ok) {
    assert.equal(noOrder.result.message, "Prodigi fetch missing order");
  }

  const noId = await liveFetch({
    env: LIVE_ENV,
    response: json({ order: { merchantReference: SESSION } }),
  });
  assert.equal(noId.result.ok, false);
  if (!noId.result.ok) {
    assert.equal(noId.result.message, "Prodigi fetch missing order id");
  }
});

test("live fetch tolerates an order with no status, no reference and no shipments", async () => {
  // Prodigi's own docs are inconsistent about which fields are always
  // present. Missing ones must degrade to null/[], never throw — a throw here
  // would be a 500 in the route and an unbounded Prodigi retry loop.
  const { result } = await liveFetch({
    env: LIVE_ENV,
    response: json({ order: { id: PRODIGI_ID } }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.stage, null);
  assert.equal(result.value.merchantReference, null);
  assert.deepEqual(result.value.shipments, []);
});

/* --- handler branches -------------------------------------------------- */

test("a subject that is not one of our order ids is dropped before any store read", async () => {
  const store = memoryOrdersStore();
  let read = false;
  const spy = {
    ...store,
    async getOrder(id: string) {
      read = true;
      return store.getOrder(id);
    },
  };
  const result = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store: spy,
    now: NOW,
    fetchOrder: async (orderId) => ({
      ok: true,
      value: {
        orderId,
        // A Prodigi order that is not ours: the reference is not one of ours,
        // so there is no record to write and nothing to claim.
        merchantReference: "not-a-checkout-session",
        stage: "Complete",
        shipments: [],
      },
    }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ignored, "unknown-order");
  assert.equal(read, false, "an unknown reference must not reach the store");
  assert.equal(store.prodigiCallbacks.size, 0, "nothing to claim, nothing claimed");
});

test("a fetched order whose id is not the event subject is dropped", async () => {
  // Guards against a replayed or reshaped callback: the body names order A,
  // the fetch returns order B. Acting on that would move A's record to B's state.
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const result = await handleProdigiCallback({
    rawBody: cloudEvent(),
    store,
    now: NOW,
    fetchOrder: async () => ({
      ok: true,
      value: {
        orderId: "ord_someone_else_zzz",
        merchantReference: SESSION,
        stage: "Complete",
        shipments: [],
      },
    }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ignored, "unknown-order");
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(record.prodigiStage, "InProgress", "nothing may be written");
});

test("a stage change with no shipped shipment writes the stage and sends no mail", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const sent: string[] = [];
  const result = await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_stage_only" }),
    store,
    sendEmail: async (mail) => {
      sent.push(mail.kind);
      return { ok: true, message: "sent" };
    },
    fetchOrder: fetchOk("Complete", [{ status: "Processing", carrier: { name: "DHL" } }]),
    now: NOW,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.stage, "Complete");
  assert.equal(result.body.shipped, false);
  assert.deepEqual(sent, []);
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(record.emailsSent, [], "no mail is claimed without a shipment");
  assert.equal(record.shipments.length, 1);
});

test("a Resend failure is logged and does not change the 200 or re-claim the mail", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await handleProdigiCallback({
      rawBody: cloudEvent({ id: "evt_send_fails" }),
      store,
      sendEmail: async () => ({ ok: false, message: "Resend HTTP 429" }),
      fetchOrder: fetchOk("Complete", [
        { status: "Shipped", tracking: { number: "1Z999" } },
      ]),
      now: NOW,
    });
    assert.equal(result.httpStatus, 200, "a mail provider hiccup is not a webhook failure");
    assert.ok(lines.some((l) => l.includes("email.failed")));
    assert.ok(lines.some((l) => l.includes("Resend HTTP 429")));
  } finally {
    console.error = original;
  }
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.ok(
    record.emailsSent.includes("print-shipped"),
    "the claim stands: a retry must not mail a second time",
  );
});

test("a sendEmail that throws is contained, not propagated to the webhook", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await handleProdigiCallback({
      rawBody: cloudEvent({ id: "evt_send_throws" }),
      store,
      sendEmail: async () => {
        throw new Error("resend exploded");
      },
      fetchOrder: fetchOk("Complete", [
        { status: "Shipped", tracking: { number: "1Z999" } },
      ]),
      now: NOW,
    });
    assert.equal(result.httpStatus, 200);
    assert.ok(lines.some((l) => l.includes("resend exploded")));
  } finally {
    console.error = original;
  }
});

test("a sendEmail that throws a non-Error is still logged as a failure", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    await handleProdigiCallback({
      rawBody: cloudEvent({ id: "evt_send_throws_bare" }),
      store,
      sendEmail: async () => {
        throw "just a string";
      },
      fetchOrder: fetchOk("Complete", [
        { status: "Shipped", tracking: { number: "1Z999" } },
      ]),
      now: NOW,
    });
    assert.ok(lines.some((l) => l.includes("email-threw")));
  } finally {
    console.error = original;
  }
});

test("a shipped callback with no sendEmail claims nothing and says why", async () => {
  // Unset RESEND_API_KEY must not burn the claim: fixing the key has to be
  // enough for this order to still get its mail on the next callback.
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await handleProdigiCallback({
      rawBody: cloudEvent({ id: "evt_no_resend" }),
      store,
      fetchOrder: fetchOk("Complete", [
        { status: "Shipped", tracking: { number: "1Z999" } },
      ]),
      now: NOW,
    });
    assert.equal(result.httpStatus, 200);
    assert.ok(lines.some((l) => l.includes("resend-unconfigured")));
  } finally {
    console.error = original;
  }
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(record.emailsSent, []);
  assert.equal(record.prodigiStage, "Complete", "the stage still persists");
});

test("a shipped callback for a record with no usable address writes stage, sends nothing", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical({ recipient: { ...RECIPIENT, email: "not-an-email" } }));
  const sent: string[] = [];
  const result = await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_bad_address" }),
    store,
    sendEmail: async (mail) => {
      sent.push(mail.kind);
      return { ok: true, message: "sent" };
    },
    fetchOrder: fetchOk("Complete", [
      { status: "Shipped", tracking: { number: "1Z999" } },
    ]),
    now: NOW,
  });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(sent, []);
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(record.emailsSent, []);
  assert.equal(record.prodigiStage, "Complete");
});

test("a non-object CloudEvent body is rejected without a 500", async () => {
  const store = memoryOrdersStore();
  for (const raw of ["null", "42", '"a string"']) {
    const result = await handleProdigiCallback({
      rawBody: raw,
      store,
      now: NOW,
      fetchOrder: fetchOk("Complete"),
    });
    assert.equal(result.httpStatus, 400, raw);
    assert.equal(result.body.error, "invalid-cloudevent", raw);
  }
});

test("a physical order with no address on the recipient still takes the stage write", async () => {
  // Prodigi can accept a print order without an email. The stage write is ours
  // to make; the mail is simply not deliverable, so no claim is taken.
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical({ recipient: { ...RECIPIENT, email: null } }));
  const result = await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_no_recipient" }),
    store,
    sendEmail: async () => ({ ok: true, message: "sent" }),
    fetchOrder: fetchOk("Complete", [
      { status: "Shipped", tracking: { number: "1Z999" } },
    ]),
    now: NOW,
  });
  assert.equal(result.httpStatus, 200);
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(record.prodigiStage, "Complete");
  assert.deepEqual(record.emailsSent, []);
});

test("the shipped copy is built with the shipment's tracking details", async () => {
  // Pins that the values come from the *fetched* shipment, and that the site
  // origin used for copy is the caller's when supplied.
  const store = memoryOrdersStore();
  await store.putOrder(paidPhysical());
  const mails: Array<{ subject: string; text: string }> = [];
  await handleProdigiCallback({
    rawBody: cloudEvent({ id: "evt_copy" }),
    store,
    sendEmail: async (mail) => {
      mails.push({ subject: mail.subject, text: mail.text });
      return { ok: true, message: "sent" };
    },
    fetchOrder: fetchOk("Complete", [
      { status: "Processing", tracking: { number: "WRONG-1" } },
      {
        status: "Shipped",
        carrier: { name: "DHL" },
        tracking: { number: "1Z999ABC", url: "https://track.example/1Z999ABC" },
      },
    ]),
    siteUrl: "https://staging.nessebarlens.com",
    now: NOW,
  });
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.subject, "Your Nessebar Lens print has shipped");
  assert.match(mails[0]!.text, /DHL/);
  assert.match(mails[0]!.text, /1Z999ABC/);
  assert.match(mails[0]!.text, /https:\/\/track\.example\/1Z999ABC/);
  assert.equal(
    mails[0]!.text.includes("WRONG-1"),
    false,
    "the first Shipped entry wins, not the first shipment",
  );
});

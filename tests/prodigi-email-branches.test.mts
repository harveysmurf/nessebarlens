/**
 * Branch coverage for the #117 additions: email copy, the Prodigi callback's
 * defensive parse/fetch mapping, and the record fields it introduced.
 *
 * The gaps these close are all *shape* branches — a missing field, a wrong
 * type, an empty string — in code whose job is to survive whatever Prodigi
 * sends. A route that 500s on an unexpected payload is a Prodigi retry loop,
 * so "degrades instead of throwing" needs to be pinned rather than assumed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  handleProdigiCallback,
  parseProdigiCloudEvent,
  shipmentsFromProdigiOrder,
  fetchProdigiOrder,
  type FetchProdigiOrder,
} from "../src/lib/prodigi-callback.ts";
import { emailCopyFor } from "../src/lib/email-copy.ts";
import { parseOrderRecord } from "../src/lib/order-decision.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";


const NOW = "2026-10-03T12:00:00.000Z";

/* --- email copy -------------------------------------------------------- */

test("shipped copy with no tracking details says so instead of printing blanks", () => {
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: "cs_test_abcdefgh",
    siteUrl: "https://nessebarlens.com",
  });
  assert.equal(copy.subject, "Your Nessebar Lens print has shipped");
  assert.match(copy.text, /Your carrier will provide tracking details separately\./);
  assert.equal(copy.text.includes("Carrier:"), false);
  assert.equal(copy.text.includes("undefined"), false);
});

test("shipped copy treats whitespace-only tracking fields as absent", () => {
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: "cs_test_abcdefgh",
    siteUrl: "https://nessebarlens.com",
    carrier: "   ",
    trackingNumber: "  ",
    trackingUrl: "",
  });
  assert.match(copy.text, /Your carrier will provide tracking details separately\./);
  assert.equal(copy.text.includes("Carrier:"), false);
});

/* --- CloudEvent parse --------------------------------------------------- */

test("a CloudEvent field of the wrong type is rejected, not coerced", () => {
  // Prodigi documents these as strings. A number here would stringify into a
  // subject we then put in a GET URL, so the parse has to refuse it.
  for (const bad of [
    { specversion: 1, id: "evt_1", subject: "ord_1" },
    { specversion: "1.0", id: 7, subject: "ord_1" },
    { specversion: "1.0", id: "evt_1", subject: null },
    { specversion: "", id: "evt_1", subject: "ord_1" },
    { specversion: "1.0", id: "evt_1", subject: "" },
  ]) {
    const parsed = parseProdigiCloudEvent(JSON.stringify(bad));
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
});

test("a CloudEvent with no data, or a data shape we do not recognise, still parses", () => {
  // The envelope is all we use; `data` is only touched to prove we can read
  // either documented nesting. Neither may become a rejection reason.
  for (const data of [undefined, null, "a string", 42, { order: "not-an-object" }, { id: "ord_1" }]) {
    const raw = JSON.stringify({
      specversion: "1.0",
      id: "evt_shape",
      subject: "ord_1",
      ...(data === undefined ? {} : { data }),
    });
    const parsed = parseProdigiCloudEvent(raw);
    assert.equal(parsed.ok, true, raw);
  }
});

/* --- shipment mapping --------------------------------------------------- */

test("shipmentsFromProdigiOrder survives every shape Prodigi might send", () => {
  assert.deepEqual(shipmentsFromProdigiOrder(null), []);
  assert.deepEqual(shipmentsFromProdigiOrder("nope"), []);
  assert.deepEqual(shipmentsFromProdigiOrder({}), []);
  assert.deepEqual(shipmentsFromProdigiOrder({ shipments: "none" }), []);
  assert.deepEqual(shipmentsFromProdigiOrder({ shipments: [null, "x", 3] }), []);

  // carrier given as a bare string (older payloads) and tracking missing.
  const bare = shipmentsFromProdigiOrder({
    shipments: [{ status: "Processing", carrier: "Royal Mail" }],
  });
  assert.equal(bare.length, 1);
  assert.equal(bare[0]!.carrier, "Royal Mail");
  assert.equal(bare[0]!.trackingUrl, "");
  assert.equal(bare[0]!.trackingNumber, "");

  // A carrier object with no name falls back to the raw value, then to "".
  const nameless = shipmentsFromProdigiOrder({
    shipments: [{ status: "Processing", carrier: { service: "Express" } }],
  });
  assert.equal(nameless[0]!.carrier, "");
});

test("shipmentsFromProdigiOrder caps the list and every field", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    status: `Status${i}`,
    carrier: { name: "C".repeat(300) },
    tracking: { number: "N".repeat(300), url: "U".repeat(300) },
  }));
  const out = shipmentsFromProdigiOrder({ shipments: many });
  assert.ok(out.length <= 20, `expected the cap to hold, got ${out.length}`);
  for (const field of ["carrier", "trackingUrl", "trackingNumber", "status"]) {
    assert.ok(
      out[0]![field].length <= 300,
      `${field} must be clipped, was ${out[0]![field].length}`,
    );
  }
});

/* --- handler branches --------------------------------------------------- */

function fetchOk(overrides: Partial<{
  orderId: string;
  merchantReference: string | null;
  stage: string | null;
  shipments: unknown[];
}> = {}): FetchProdigiOrder {
  return async (orderId) => ({
    ok: true,
    value: {
      orderId: overrides.orderId ?? orderId,
      merchantReference:
        overrides.merchantReference === undefined
          ? "cs_test_abcdefgh"
          : overrides.merchantReference,
      stage: "stage" in overrides ? overrides.stage! : "Complete",
      shipments: shipmentsFromProdigiOrder({
        shipments: overrides.shipments ?? [],
      }),
    },
  });
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    specversion: "1.0",
    id: "evt_branch_1",
    subject: "ord_abc123xyz",
    ...overrides,
  });
}

test("a fetched order with no merchant reference is dropped as unknown", async () => {
  // Prodigi omits merchantReference on orders placed outside our checkout. We
  // have no session to key on, so there is nothing to write — and 200, so
  // Prodigi stops retrying an event we will never be able to act on.
  const store = memoryOrdersStore();
  const result = await handleProdigiCallback({
    rawBody: event(),
    store,
    now: NOW,
    fetchOrder: fetchOk({ merchantReference: null }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ignored, "unknown-order");
  assert.equal(store.orderPuts.length, 0);
});

test("a session id we have no record for is dropped as unknown", async () => {
  const store = memoryOrdersStore();
  const result = await handleProdigiCallback({
    rawBody: event(),
    store,
    now: NOW,
    fetchOrder: fetchOk({ merchantReference: "cs_test_nosuchrecord" }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ignored, "unknown-order");
});

test("a null stage persists as null rather than inventing one", async () => {
  const store = memoryOrdersStore();
  await store.putOrder(
    JSON.parse(
      JSON.stringify({
        ...baseRecord(),
      }),
    ),
  );
  const result = await handleProdigiCallback({
    rawBody: event({ id: "evt_null_stage" }),
    store,
    now: NOW,
    fetchOrder: fetchOk({ stage: null }),
  });
  assert.equal(result.httpStatus, 200);
  const record = parseOrderRecord((await store.getOrder("cs_test_abcdefgh"))!)!;
  assert.equal(record.prodigiStage, null);
  assert.equal(result.body.stage, null);
});

function baseRecord() {
  return {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    merchantReference: "cs_test_abcdefgh",
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
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: "buyer@example.com",
      phone: null,
    },
    prodigiOrderId: "ord_abc123xyz",
    prodigiStage: "InProgress",
    assetUrl:
      "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=" + "a".repeat(64),
    updatedAt: NOW,
    createdAt: NOW,
    attempts: 1,
    shipments: [],
    emailsSent: [],
  };
}

/* --- live fetch edge shapes -------------------------------------------- */

const LIVE_ENV = {
  PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
  PRODIGI_SANDBOX_API_KEY: "sandbox-key-for-callback-tests",
};

async function liveFetch(response: Response): Promise<unknown> {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  globalThis.fetch = (async () => response) as typeof fetch;
  for (const [k, v] of Object.entries(LIVE_ENV)) process.env[k] = v;
  try {
    return await fetchProdigiOrder("ord_abc123xyz");
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  }
}

test("a 200 whose order has no status degrades to a null stage", async () => {
  const result = (await liveFetch(
    new Response(JSON.stringify({ order: { id: "ord_abc123xyz" } }), { status: 200 }),
  )) as { ok: boolean; value: { stage: string | null } };
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.stage, null);
});

test("a failed fetch with an unreadable body still reports the HTTP status", async () => {
  const result = (await liveFetch(
    new Response("upstream exploded", { status: 502 }),
  )) as { ok: boolean; message: string; status: number | null };
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /Prodigi fetch HTTP 502/);
  assert.equal(result.status, 502);
});

test("a 200 whose body cannot be read degrades to invalid JSON, not a throw", async () => {
  // A Worker response whose stream dies mid-body must not reject out of
  // fetchProdigiOrder: the callback route turns that rejection into a 500 for
  // Prodigi to retry, which is right, but the parse itself must stay total.
  const broken = {
    ok: true,
    status: 200,
    text: () => Promise.reject(new Error("stream closed")),
  } as unknown as Response;
  const result = (await liveFetch(broken)) as { ok: boolean; message: string };
  assert.equal(result.ok, false);
  assert.equal(result.message, "Prodigi fetch invalid JSON");
});
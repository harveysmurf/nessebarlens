/**
 * Audit script for refunded/disputed physical orders vs Prodigi (#309).
 *
 * Tests cover the pure, injectable pieces: row filtering (physical with a
 * prodigiOrderId is kept; digital or without an ID is skipped), table formatting,
 * the cancellable stage check, amount formatting, Prodigi response extraction,
 * and arg parsing. The full runAudit flow is exercised with mocked spawn/fetch/cancel.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  parseRefundRecord,
  filterAuditableRows,
  isShippedOrder,
  formatAmount,
  formatAuditTable,
  formatAuditRow,
  extractProdigiOrder,
  readProdigiOrder,
  formatCancelTable,
  runAudit,
} from "../scripts/audit-prodigi-cancellations.mjs";

const SESSION = "cs_test_abcdefgh";
const PRODIGI_ID = "ord_abc123xyz";

function physicalRecord(overrides = {}) {
  return JSON.stringify({
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "refunded",
    kind: "physical",
    format: "giclee",
    photoSlug: "nessebar-harbour",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: null,
    masterKey: null,
    prodigiOrderId: PRODIGI_ID,
    prodigiStage: "InProgress",
    assetUrl: null,
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: null,
      phone: null,
    },
    shipments: [],
    emailsSent: [],
    updatedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    attempts: 1,
    ...overrides,
  });
}

function d1Row(record) {
  let parsed;
  try {
    parsed = JSON.parse(record);
  } catch {
    parsed = null;
  }
  return {
    session_id: parsed?.sessionId ?? "",
    status: parsed?.status ?? "unknown",
    reason: parsed?.reason ?? null,
    attempts: 1,
    created_at: "2026-10-01T00:00:00.000Z",
    record,
  };
}

/* --- arg parsing --- */

test("parseArgs defaults to read-only with a limit", () => {
  assert.deepEqual(parseArgs([]), { cancel: false, limit: 100, help: false });
  assert.deepEqual(parseArgs(["--limit", "50"]), { cancel: false, limit: "50", help: false });
});

test("parseArgs enables cancel mode", () => {
  assert.equal(parseArgs(["--cancel"]).cancel, true);
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--cancel", "--what"]), /unknown argument/);
});

test("parseArgs prints usage for --help", () => {
  const r = parseArgs(["--help"]);
  assert.equal(r.help, true);
  assert.equal(r.cancel, false);
});

/* --- record filtering --- */

test("parseRefundRecord keeps physical orders with a prodigiOrderId", () => {
  const rec = physicalRecord();
  const parsed = parseRefundRecord(rec);
  assert.ok(parsed, "physical order with prodigiOrderId should be kept");
  assert.equal(parsed?.prodigiOrderId, PRODIGI_ID);
  assert.equal(parsed?.sessionId, SESSION);
  assert.equal(parsed?.localStage, "InProgress");
  assert.equal(parsed?.amountTotal, 1999);
  assert.equal(parsed?.format, "giclee");
});

test("parseRefundRecord skips digital orders", () => {
  const rec = physicalRecord({
    kind: "digital",
    format: "digital",
    prodigiOrderId: null,
  });
  assert.equal(parseRefundRecord(rec), null);
});

test("parseRefundRecord skips physical orders without a prodigiOrderId", () => {
  const rec = physicalRecord({
    prodigiOrderId: null,
    prodigiStage: null,
  });
  assert.equal(parseRefundRecord(rec), null);
});

test("parseRefundRecord skips orders with an unsafe prodigiOrderId", () => {
  const rec = physicalRecord({ prodigiOrderId: "../escape" });
  assert.equal(parseRefundRecord(rec), null);
});

test("parseRefundRecord skips corrupt JSON", () => {
  assert.equal(parseRefundRecord("{not json}"), null);
  assert.equal(parseRefundRecord(""), null);
  assert.equal(parseRefundRecord(null), null);
});

test("filterAuditableRows keeps only auditable rows and preserves D1 status", () => {
  const rows = [
    d1Row(physicalRecord({ status: "refunded", prodigiStage: "InProgress" })),
    d1Row(physicalRecord({ status: "disputed", prodigiStage: "OrderCreated" })),
    d1Row(physicalRecord({ kind: "digital", format: "digital", prodigiOrderId: null })),
    d1Row(physicalRecord({ prodigiOrderId: null, prodigiStage: null })),
    d1Row("not json at all"),
  ];
  const result = filterAuditableRows(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.sessionId, SESSION);
  assert.equal(result[1]?.sessionId, SESSION);
  assert.equal(result[0]?.status, "refunded");
  assert.equal(result[1]?.status, "disputed");
});

/* --- cancellability check --- */

test("isShippedOrder flags shipped/delivered/returned/cancelled stages", () => {
  assert.equal(isShippedOrder("Shipped", []), true);
  assert.equal(isShippedOrder("Delivered", []), true);
  assert.equal(isShippedOrder("Returned", []), true);
  assert.equal(isShippedOrder("ReturnRequested", []), true);
  assert.equal(isShippedOrder("Cancelled", []), true);
  assert.equal(isShippedOrder("CancelFailed", []), true);
});

test("isShippedOrder allows in-production stages and ReadyToShip", () => {
  assert.equal(isShippedOrder("OrderCreated", []), false);
  assert.equal(isShippedOrder("InProgress", []), false);
  assert.equal(isShippedOrder("InProduction", []), false);
  assert.equal(isShippedOrder("ReadyToShip", []), false);
  assert.equal(isShippedOrder("QualityCheck", []), false);
  assert.equal(isShippedOrder(null, []), false);
  assert.equal(isShippedOrder("", []), false);
});

test("isShippedOrder flags any shipment with status Shipped", () => {
  assert.equal(isShippedOrder(null, [{ status: "Shipped" }]), true);
  assert.equal(isShippedOrder("InProgress", [{ status: "Shipped" }]), true);
  assert.equal(isShippedOrder("InProgress", [{ status: "Processing" }]), false);
  assert.equal(isShippedOrder("InProgress", []), false);
  assert.equal(isShippedOrder("InProgress", null), false);
});

/* --- amount formatting --- */

test("formatAmount renders integer cents as euros", () => {
  assert.equal(formatAmount(1999), "19.99€");
  assert.equal(formatAmount(3000), "30.00€");
  assert.equal(formatAmount(0), "0.00€");
  assert.equal(formatAmount(-500), "-5.00€");
  assert.equal(formatAmount(100), "1.00€");
});

test("formatAmount passes through non-numbers", () => {
  assert.equal(formatAmount("1999"), "1999");
  assert.equal(formatAmount(undefined), "undefined");
});

/* --- Prodigi response extraction --- */

test("extractProdigiOrder parses stage and shipments from a full response", () => {
  const raw = JSON.stringify({
    outcome: "SUCCESS",
    order: {
      id: PRODIGI_ID,
      merchantReference: SESSION,
      status: { stage: "Complete" },
      shipments: [
        { status: "Shipped", carrier: { name: "DHL" } },
      ],
    },
  });
  const parsed = extractProdigiOrder(raw);
  assert.ok(parsed);
  assert.equal(parsed?.stage, "Complete");
  assert.equal(parsed?.shipments.length, 1);
  assert.equal(parsed?.shipments[0]?.status, "Shipped");
});

test("extractProdigiOrder tolerates missing stage and shipments", () => {
  const parsed = extractProdigiOrder(JSON.stringify({ order: { id: PRODIGI_ID } }));
  assert.ok(parsed);
  assert.equal(parsed?.stage, null);
  assert.deepEqual(parsed?.shipments, []);
});

test("extractProdigiOrder rejects unparseable or missing order", () => {
  assert.equal(extractProdigiOrder("not json"), null);
  assert.equal(extractProdigiOrder(JSON.stringify({ outcome: "SUCCESS" })), null);
  assert.equal(extractProdigiOrder(JSON.stringify({ order: null })), null);
});

/* --- readProdigiOrder (GET) --- */

test("readProdigiOrder returns stage and shipments on 200", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        order: {
          id: PRODIGI_ID,
          status: { stage: "InProgress" },
          shipments: [{ status: "Processing" }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const result = await readProdigiOrder(
    "https://api.prodigi.com", "test-key", PRODIGI_ID, fetchImpl,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.stage, "InProgress");
  assert.equal(result.ok && result.shipments.length, 1);
});

test("readProdigiOrder reports HTTP failures with the status", async () => {
  const fetchImpl = async () => new Response("Not found", { status: 404 });
  const result = await readProdigiOrder(
    "https://api.prodigi.com", "test-key", PRODIGI_ID, fetchImpl,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 404);
  assert.match(result.ok === false ? result.message : "", /404/);
});

test("readProdigiOrder reports network failures", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const result = await readProdigiOrder(
    "https://api.prodigi.com", "test-key", PRODIGI_ID, fetchImpl,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.message, "ECONNRESET");
  assert.equal(result.ok === false && result.status, null);
});

/* --- table formatting --- */

test("formatAuditTable produces a header, rows, and a count", () => {
  const entries = [
    {
      sessionId: SESSION,
      prodigiOrderId: PRODIGI_ID,
      localStage: "InProgress",
      readStage: "Complete",
      prodigiShipments: [{ status: "Shipped", carrier: "DHL" }],
      amountTotal: 1999,
      isCancellable: false,
    },
    {
      sessionId: "cs_test_bbbbbbbb",
      prodigiOrderId: "ord_nobiggie123",
      localStage: "created",
      readStage: "OrderCreated",
      prodigiShipments: [],
      amountTotal: 3000,
      isCancellable: true,
    },
  ];
  const table = formatAuditTable(entries);
  assert.match(table, /session_id\tprodigi_order_id/);
  assert.match(table, /InProgress\tComplete/);
  assert.match(table, /19.99€/);
  assert.match(table, /30.00€/);
  assert.match(table, /yes/);
  assert.match(table, /no/);
   assert.match(table, /# 2 order\(s\)/);
});

test("formatAuditRow marks read failures in the prodigi_stage column", () => {
  const entry = {
    sessionId: SESSION,
    prodigiOrderId: PRODIGI_ID,
    localStage: "InProgress",
    readStage: null,
    readError: "Prodigi GET HTTP 503",
    prodigiShipments: [],
    amountTotal: 1999,
    isCancellable: false,
  };
  const row = formatAuditRow(entry);
  assert.match(row, /-/);
  assert.match(row, /ERR:Prodigi GET HTTP 503/);
});

test("formatCancelTable reports cancel outcomes and re-read stages", () => {
  const entries = [
    {
      sessionId: SESSION,
      prodigiOrderId: PRODIGI_ID,
      cancelResult: { ok: true, status: 200 },
      reReadStage: "Cancelled",
      reReadShipments: [],
    },
    {
      sessionId: "cs_test_bbbbbbbb",
      prodigiOrderId: "ord_other12345",
      cancelResult: { ok: false, status: 405, reason: "prodigi-cancel-http-405", message: "Prodigi cancel HTTP 405" },
      reReadStage: "InProduction",
      reReadShipments: [],
    },
  ];
  const table = formatCancelTable(entries);
  assert.match(table, /cancelled/);
  assert.match(table, /failed:prodigi-cancel-http-405/);
  assert.match(table, /Cancelled/);
  assert.match(table, /InProduction/);
  assert.match(table, /# cancel: 1 ok, 1 failed/);
});

/* --- runAudit integration (mocked) --- */

test("runAudit refuses a sandbox or unconfigured Prodigi base", async () => {
  const saved = { ...process.env };
  delete process.env.PRODIGI_API_BASE;
  delete process.env.PRODIGI_API_KEY;
  delete process.env.PRODIGI_SANDBOX_API_KEY;
  try {
    const out = await runAudit([]);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /PRODIGI_API_BASE must be/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test("runAudit refuses sandbox base even when configured", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "sandbox-key";
  try {
    const out = await runAudit([]);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /must be .*api\.prodigi\.com/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test("runAudit lists refunded/disputed rows, filters physical+prodigiOrderId, and reads Prodigi", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.prodigi.com";
  process.env.PRODIGI_API_KEY = "live-key";

  const d1Output = JSON.stringify([
    {
      results: [
        d1Row(physicalRecord({ prodigiStage: "in-production", prodigiOrderId: PRODIGI_ID })),
        d1Row(physicalRecord({ prodigiStage: "created", prodigiOrderId: "ord_shipped123" })),
        d1Row(physicalRecord({ kind: "digital", format: "digital", prodigiOrderId: null })),
      ],
    },
  ]);

  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount++;
    const id = new URL(String(url)).pathname.split("/").pop();
    if (id === PRODIGI_ID) {
      return new Response(
        JSON.stringify({
          order: {
            id,
            status: { stage: "InProduction" },
            shipments: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        order: {
          id,
          status: { stage: "Shipped" },
          shipments: [{ status: "Shipped", carrier: { name: "DHL" } }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const spawn = () => ({
    status: 0,
    stdout: d1Output,
    stderr: "",
  });

  try {
    const out = await runAudit([], { spawnSync: spawn, fetch: fetchImpl });
    assert.equal(out.exitCode, 0);
    assert.equal(fetchCount, 2, "should fetch Prodigi for each physical order with an id");
    // Two physical orders kept; the digital one was filtered out.
    assert.match(out.stdout, /# 2 order\(s\)/);
    // One is cancellable (InProduction), one is not (Shipped).
    assert.match(out.stdout, /\tyes\n/);
    assert.match(out.stdout, /\tno\n/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test("runAudit --cancel cancels only cancellable orders, re-reads, and reports", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.prodigi.com";
  process.env.PRODIGI_API_KEY = "live-key";

  let cancelCount = 0;
  const fetchImpl = async (url) => {
    const id = new URL(String(url)).pathname.split("/").pop();
    // First GET (read): InProduction (cancellable)
    // Second GET after cancel: Cancelled
    if (id === PRODIGI_ID) {
      const stage = cancelCount === 0 ? "InProduction" : "Cancelled";
      return new Response(
        JSON.stringify({
          order: { id, status: { stage }, shipments: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        order: {
          id,
          status: { stage: "Shipped" },
          shipments: [{ status: "Shipped", carrier: { name: "DHL" } }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const cancelImpl = async ({ prodigiOrderId }) => {
    cancelCount++;
    assert.equal(prodigiOrderId, PRODIGI_ID, "should only cancel the cancellable order");
    return { ok: true, status: 200 };
  };

  const spawn = () => ({
    status: 0,
    stdout: JSON.stringify([
      {
        results: [
          d1Row(physicalRecord({ prodigiStage: "in-production", prodigiOrderId: PRODIGI_ID })),
          d1Row(physicalRecord({ prodigiStage: "shipped", prodigiOrderId: "ord_shipped123" })),
        ],
      },
    ]),
    stderr: "",
  });

  try {
    const out = await runAudit(["--cancel"], {
      spawnSync: spawn,
      fetch: fetchImpl,
      cancelProdigiOrder: cancelImpl,
    });
    assert.equal(out.exitCode, 0);
    assert.equal(cancelCount, 1, "should only cancel the cancellable order");
    assert.match(out.stdout, /# cancel: 1 ok, 0 failed/);
    assert.match(out.stdout, /Cancelled/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test("runAudit --cancel reports failure without crashing", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.prodigi.com";
  process.env.PRODIGI_API_KEY = "live-key";

   const fetchImpl = async () =>
     new Response(
       JSON.stringify({
         order: {
           id: "ord_test_abc",
          status: { stage: "InProduction" },
          shipments: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const cancelImpl = async () => ({
    ok: false,
    status: 405,
    reason: "prodigi-cancel-http-405",
    message: "Prodigi cancel HTTP 405",
  });

  const spawn = () => ({
    status: 0,
    stdout: JSON.stringify([
      {
        results: [
          d1Row(physicalRecord({ prodigiOrderId: "ord_test_abc", prodigiStage: "in-production" })),
        ],
      },
    ]),
    stderr: "",
  });

  try {
    const out = await runAudit(["--cancel"], {
      spawnSync: spawn,
      fetch: fetchImpl,
      cancelProdigiOrder: cancelImpl,
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /# cancel: 0 ok, 1 failed/);
    assert.match(out.stdout, /failed:prodigi-cancel-http-405/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});

test("runAudit prints the SQL header and parameterised query", async () => {
  const saved = { ...process.env };
  process.env.PRODIGI_API_BASE = "https://api.prodigi.com";
  process.env.PRODIGI_API_KEY = "live-key";

  const spawn = () => ({
    status: 0,
    stdout: JSON.stringify([{ results: [] }]),
    stderr: "",
  });

  const fetchImpl = async () => {
    throw new Error("should not be called when there are no orders");
  };

  try {
    const out = await runAudit([], { spawnSync: spawn, fetch: fetchImpl });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /status IN \(.*refunded.*disputed.*\)/);
    assert.match(out.stdout, /# SQL \(parameterised\):/);
    assert.match(out.stdout, /# SQL \(runnable\):/);
    assert.match(out.stdout, /# 0 order\(s\)/);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
});
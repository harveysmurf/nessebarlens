/**
 * D1 OrdersStore against a fake D1Database (#116).
 *
 * Every port method and every branch the coverage floor cares about: not-found,
 * meta.changes boolean, spendDownloadToken classification, batch, list filters.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { d1OrdersStore, listOrdersQuery } from "../src/infrastructure/cloudflare/orders-d1.ts";
import { clampOrderListLimit } from "../src/domain/ordering/orders-store.ts";
import { sqliteD1 } from "./sqlite-d1.mts";
import type { OrderRecord } from "../src/domain/ordering/order-decision.ts";
import type { DownloadTokenIndex, DownloadTokenRecord } from "../src/domain/ordering/download-token.ts";
import {
  SAMPLE_MASTER_KEY,
  SAMPLE_SLUG,
} from "./fixtures/sample-photo.mts";

const BASE_ORDER: OrderRecord = {
  v: 1,
  sessionId: "cs_test_abcdefgh",
  merchantReference: "cs_test_abcdefgh",
  terminal: true,
  status: "paid",
  photoSlug: SAMPLE_SLUG,
  format: "digital",
  size: "",
  frame: "",
  quoteEur: 30,
  amountTotal: 3000,
  currency: "eur",
  reason: null,
  masterKey: SAMPLE_MASTER_KEY,
  recipient: null,
  prodigiOrderId: null,
  prodigiStage: null,
  assetUrl: null,
  updatedAt: "2026-10-02T00:00:00.000Z",
  createdAt: "2026-10-02T00:00:00.000Z",
  attempts: 1,
  shipments: [],
  emailsSent: [],
};

test("getOrder returns null when missing and the raw JSON when present", async () => {
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  assert.equal(await store.getOrder("cs_test_abcdefgh"), null);
  await store.putOrder(BASE_ORDER);
  const raw = await store.getOrder("cs_test_abcdefgh");
  assert.ok(raw);
  assert.equal(JSON.parse(raw).sessionId, "cs_test_abcdefgh");
});

test("transitionOrder is true only when attempts still match", async () => {
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  await store.putOrder(BASE_ORDER);
  const ok = await store.transitionOrder({
    sessionId: "cs_test_abcdefgh",
    fromAttempts: 1,
    record: { ...BASE_ORDER, status: "refunded", masterKey: null, terminal: true },
  });
  assert.equal(ok, true);
  const lost = await store.transitionOrder({
    sessionId: "cs_test_abcdefgh",
    fromAttempts: 1,
    record: BASE_ORDER,
  });
  assert.equal(lost, false);
});

test("listOrdersQuery is parameterised and clamps the limit", () => {
  const retryable = listOrdersQuery({ retryable: true, limit: 10 });
  assert.match(retryable.sql, /status = \? AND terminal = 0/);
  assert.deepEqual(retryable.binds, ["paid-unfulfilled", 10]);

  const revoked = listOrdersQuery({ revoked: true });
  assert.match(revoked.sql, /status IN \(\?, \?\)/);
  assert.equal(clampOrderListLimit(9999), 500);
  assert.equal(clampOrderListLimit(0), 100);
  assert.equal(clampOrderListLimit(undefined), 100);
});

test("listOrders skips corrupt JSON rows", async () => {
  const db = sqliteD1();
  // A `record` column that is not JSON is what a partial write or a bad
  // migration leaves behind. With the real schema the corrupt row has to be
  // inserted directly — putOrder would parse and reject it — so this is the
  // one place a raw INSERT is the point.
  db.prepare(
    `INSERT INTO orders (
       session_id, record, status, terminal, reason,
       attempts, updated_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "cs_test_badjson00000000001",
      "not-json",
      "paid",
      1,
      null,
      1,
      "2026-10-02T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
    )
    .run();
  const store = d1OrdersStore(db as never);
  await store.putOrder({
    ...BASE_ORDER,
    sessionId: "cs_test_goodrecord00000001",
    merchantReference: "cs_test_goodrecord00000001",
  });
  const listed = await store.listOrders({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.sessionId, "cs_test_goodrecord00000001");
});

test("putDownloadToken uses batch; find and get round-trip", async () => {
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  const record: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: 4102444800,
    remaining: 5,
  };
  const index: DownloadTokenIndex = { ...record, token: "a".repeat(32) };
  await store.putDownloadToken(record, index);
  assert.equal(await store.getDownloadToken("a".repeat(32)), JSON.stringify(record));
  assert.ok(await store.findDownloadToken("cs_test_abcdefgh"));
});

test("spendDownloadToken classifies missing, expired, exhausted, and spent", async () => {
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  const nowMs = Date.UTC(2026, 9, 2);

  assert.deepEqual(await store.spendDownloadToken("b".repeat(32), nowMs), {
    kind: "missing",
  });

  const expired: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: Math.floor(nowMs / 1000) - 10,
    remaining: 5,
  };
  await store.putDownloadToken(expired, { ...expired, token: "c".repeat(32) });
  assert.deepEqual(await store.spendDownloadToken("c".repeat(32), nowMs), {
    kind: "expired",
  });

  const exhausted: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: Math.floor(nowMs / 1000) + 100,
    remaining: 0,
  };
  await store.putDownloadToken(exhausted, { ...exhausted, token: "d".repeat(32) });
  // putDownloadToken writes `downloads` from `remaining`, which is 0 here, so
  // the row is already exhausted in the real table.
  assert.deepEqual(await store.spendDownloadToken("d".repeat(32), nowMs), {
    kind: "exhausted",
  });

  const live: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: Math.floor(nowMs / 1000) + 100,
    remaining: 2,
  };
  await store.putDownloadToken(live, { ...live, token: "e".repeat(32) });
  const spent = await store.spendDownloadToken("e".repeat(32), nowMs);
  assert.equal(spent.kind, "spent");
  if (spent.kind === "spent") assert.equal(spent.record.remaining, 1);
});

test("a spend whose RETURNING row will not parse rebuilds the record from the columns", async () => {
  // The UPDATE is the atomic counter, so its own columns are authoritative even
  // when the JSON column is unreadable — a corrupted record must not turn a
  // legitimate download into a 500.
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  const nowMs = Date.UTC(2026, 9, 2);
  const live: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: Math.floor(nowMs / 1000) + 100,
    remaining: 2,
  };
  const token = "f".repeat(32);
  await store.putDownloadToken(live, { ...live, token });
  db.returnRawRecordFor(token, "{not json");

  const spent = await store.spendDownloadToken(token, nowMs);
  assert.equal(spent.kind, "spent");
  if (spent.kind === "spent") {
    assert.equal(spent.record.sessionId, "cs_test_abcdefgh");
    assert.equal(spent.record.remaining, 1);
  }
});

test("a spend that changes no rows but still looks live is exhausted, not a crash", async () => {
  // The race the fallback exists for: another spend took the last download
  // between our UPDATE and our SELECT. The customer must get the same 410 a
  // fully spent token gets, so the store answers "exhausted".
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  const nowMs = Date.UTC(2026, 9, 2);
  const live: DownloadTokenRecord = {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: Math.floor(nowMs / 1000) + 100,
    remaining: 2,
  };
  const token = "0".repeat(32);
  await store.putDownloadToken(live, { ...live, token });
  db.refuseSpendFor(token);

  assert.deepEqual(await store.spendDownloadToken(token, nowMs), {
    kind: "exhausted",
  });
});

test("listOrdersQuery binds an explicit status list", () => {
  const filtered = listOrdersQuery({ status: ["refunded", "disputed", "paid"] });
  assert.match(filtered.sql, /status IN \(\?, \?, \?\)/);
  assert.deepEqual(filtered.binds, ["refunded", "disputed", "paid", 100]);
});

test("a non-terminal order stores terminal 0, and a blank createdAt falls back", async () => {
  // `terminal` is the reconciler's predicate and `created_at` is its age, so
  // both columns have to be written for the state they are meant to describe —
  // including for a record whose createdAt is still blank, which is what a
  // store's first write of a pre-`createdAt` order looks like.
  const db = sqliteD1();
  const store = d1OrdersStore(db as never);
  const blank: OrderRecord = {
    ...BASE_ORDER,
    sessionId: "cs_test_blankcreatedat00001",
    merchantReference: "cs_test_blankcreatedat00001",
    terminal: false,
    status: "paid-unfulfilled",
    reason: "prodigi-unavailable",
    createdAt: "",
  };
  await store.putOrder(blank);
  const afterPut = db.query<{ terminal: number; created_at: string }>(
    "SELECT terminal, created_at FROM orders WHERE session_id = ?",
    blank.sessionId,
  )[0]!;
  assert.equal(afterPut.terminal, 0);
  assert.equal(afterPut.created_at, BASE_ORDER.updatedAt);

  const ok = await store.transitionOrder({
    sessionId: blank.sessionId,
    fromAttempts: 1,
    record: { ...blank, reason: "prodigi-client" },
  });
  assert.equal(ok, true);
  const afterTransition = db.query<{ terminal: number; created_at: string }>(
    "SELECT terminal, created_at FROM orders WHERE session_id = ?",
    blank.sessionId,
  )[0]!;
  assert.equal(afterTransition.terminal, 0);
  assert.equal(afterTransition.created_at, BASE_ORDER.updatedAt);
});

test("a token and an index that are not in the database read as absent", async () => {
  const store = d1OrdersStore(sqliteD1() as never);
  assert.equal(await store.getDownloadToken("a".repeat(32)), null);
  assert.equal(await store.findDownloadToken("cs_test_abcdefgh"), null);
});

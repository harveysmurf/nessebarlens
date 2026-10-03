import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devOrdersSeed, seededOrdersStore } from "../src/lib/orders-dev-seed.ts";
import { parseOrderRecord, orderViewState } from "../src/lib/order-decision.ts";
import { isCheckoutSessionId } from "../src/lib/order-decision.ts";
import { isProduction } from "../src/lib/config.ts";

const SEED_PATH = "e2e/fixtures/orders-seed.json";

const SEED = { ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "test" };
const PRODUCTION = { ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "production" };

test("no flag means no seed, so every other dev and test run is untouched", () => {
  assert.equal(devOrdersSeed({}), undefined);
  assert.equal(devOrdersSeed({ NODE_ENV: "test" }), undefined);
  assert.equal(devOrdersSeed({ ORDERS_DEV_SEED: "   " }), undefined);
});

test("the seed refuses to run under NODE_ENV=production", () => {
  assert.throws(() => devOrdersSeed(PRODUCTION), /refusing to use ORDERS_DEV_SEED/);
  assert.equal(isProduction({ NODE_ENV: "production " }), true);
  assert.throws(
    () => devOrdersSeed({ ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "production " }),
    /refusing to use ORDERS_DEV_SEED/,
  );
});

test("readWorkerBindings returns the seed only when there is no real binding", async () => {
  const { readWorkerBindings, isOrdersStore } = await import("../src/lib/worker-bindings.ts");
  const readEnv = async () => ({});

  assert.equal((await readWorkerBindings({ readEnv })).ORDERS_DB, undefined);

  const seeded = await readWorkerBindings({ readEnv: async () => ({ ...SEED }) });
  assert.notEqual(seeded.ORDERS_DB, undefined);
  assert.equal(seeded.MASTERS, undefined);
  assert.equal(isOrdersStore(seeded.ORDERS_DB), true);

  const real = (await import("./fake-orders-store.mts")).memoryOrdersStore();
  const withReal = await readWorkerBindings({
    readEnv: async () => ({ ORDERS_DB: real, ...SEED }),
  });
  assert.notEqual(withReal.ORDERS_DB, real);
  assert.equal(
    await withReal.ORDERS_DB?.getOrder("cs_test_e2edigitalpaid00000001"),
    await seededOrdersStore(SEED_PATH).getOrder("cs_test_e2edigitalpaid00000001"),
  );

  const unseeded = await readWorkerBindings({
    readEnv: async () => ({ ORDERS_DB: real, NODE_ENV: "test" }),
  });
  assert.equal(unseeded.ORDERS_DB, real);
});

test("readWorkerBindings propagates the production refusal rather than swallowing it", async () => {
  const { readWorkerBindings } = await import("../src/lib/worker-bindings.ts");
  await assert.rejects(
    () => readWorkerBindings({ readEnv: async () => ({ ...PRODUCTION }) }),
    /refusing to use ORDERS_DEV_SEED/,
  );
});

test("a missing or malformed seed file fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "orders-seed-"));
  const nested = join(dir, "nested.json");
  writeFileSync(nested, JSON.stringify({ cs_test_a: { v: 1 } }));
  const list = join(dir, "list.json");
  writeFileSync(list, JSON.stringify([{ v: 1 }]));

  assert.throws(() => seededOrdersStore(join(dir, "absent.json")), /cannot read seed file/);
  assert.throws(() => seededOrdersStore(nested), /must be a JSON \*string\*/);
  assert.throws(() => seededOrdersStore(list), /must be a JSON object/);
});

test("the store shape passes the same guard a real binding must pass", async () => {
  const { isOrdersStore } = await import("../src/lib/worker-bindings.ts");
  const store = seededOrdersStore(SEED_PATH);
  assert.equal(isOrdersStore(store), true);
});

test("the seed is in-memory: a put is visible to get, and nothing persists", async () => {
  const store = seededOrdersStore(SEED_PATH);
  assert.equal(await store.getOrder("cs_test_written_here_0000000099"), null);
  await store.putOrder({
    v: 1,
    sessionId: "cs_test_written_here_0000000099",
    merchantReference: "cs_test_written_here_0000000099",
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: "dawn",
    kind: "unknown",
    format: "unknown",
    size: "",
    frame: "",
    quoteEur: 0,
    amountTotal: 0,
    currency: "eur",
    reason: "bad-metadata",
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-02T00:00:00.000Z",
    createdAt: "2026-10-02T00:00:00.000Z",
    attempts: 1,
    shipments: [],
    emailsSent: [],
  });
  assert.ok(await store.getOrder("cs_test_written_here_0000000099"));

  assert.equal(
    await seededOrdersStore(SEED_PATH).getOrder("cs_test_written_here_0000000099"),
    null,
  );
});

test("every seeded record parses and yields the state its fixture claims", async () => {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  assert.ok(Object.keys(raw).length >= 3, "expected at least three seeded states");

  const tokenKeys = Object.keys(raw).filter((key) => key.startsWith("d"));
  const orderKeys = Object.keys(raw).filter((key) => !key.startsWith("d"));
  assert.deepEqual(
    [...tokenKeys].sort((a, b) => a.localeCompare(b)),
    ["dl:e2ef17e0000000000000000000000aa0", "dls:cs_test_e2edigitalpaid00000001"],
    "the seeded download tokens changed; update this and the e2e spec's href",
  );

  const states = new Map<string, string>();
  for (const sessionId of orderKeys) {
    const value = raw[sessionId]!;
    assert.equal(isCheckoutSessionId(sessionId), true, sessionId);
    const order = parseOrderRecord(value);
    assert.ok(order, `seed record does not parse: ${sessionId}`);
    assert.equal(order.sessionId, sessionId, "record must name the key it is filed under");
    states.set(sessionId, orderViewState(order));
  }

  assert.deepEqual(
    [...states.values()].sort(),
    ["digital-pending", "digital-ready", "physical"],
  );
});

test("the paid digital fixture carries a master key the catalog actually has", async () => {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  for (const [sessionId, value] of Object.entries(raw)) {
    if (sessionId.startsWith("d")) continue;
    const order = parseOrderRecord(value);
    assert.ok(order, sessionId);
    if (order.format === "digital" && order.status === "paid") {
      assert.equal(order.masterKey, masterKeyForSlug(order.photoSlug));
      assert.notEqual(order.masterKey, null, `${order.photoSlug} is not in the catalog`);
    }
  }
});

test("the seeded token is the one the paid digital order resolves to (#111)", async () => {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  const { downloadLinkForSession } = await import("../src/lib/download-token.ts");
  const { parseDownloadTokenRecord } = await import("../src/lib/download-token.ts");
  const store = seededOrdersStore(SEED_PATH);
  const paid = "cs_test_e2edigitalpaid00000001";

  assert.equal(await store.getOrder(paid), raw[paid], "the seed is read as-is");
  assert.equal(await downloadLinkForSession(store, "cs_test_e2ephysicalawaitingprodigi03"), null);
  assert.equal(await downloadLinkForSession(store, "cs_test_e2edigitalpending000002"), null);

  const link = await downloadLinkForSession(store, paid);
  assert.equal(link, "/api/download?token=e2ef17e0000000000000000000000aa0");

  assert.ok(
    parseDownloadTokenRecord((await store.getDownloadToken("e2ef17e0000000000000000000000aa0"))!),
  );
});

test("the seeded store implements the whole port, not just the reads the spec makes", async () => {
  // The E2E spec reads through this store, so a port method left unimplemented
  // would only surface the first time a dev exercised a real path against it.
  const store = seededOrdersStore(SEED_PATH);
  const NOW_MS = Date.UTC(2026, 9, 2);

  const token = JSON.parse(
    (await store.getDownloadToken("e2ef17e0000000000000000000000aa0"))!,
  ) as { remaining: number; sessionId: string };
  assert.equal(token.remaining, 5);

  const spent = await store.spendDownloadToken("e2ef17e0000000000000000000000aa0", NOW_MS);
  assert.equal(spent.kind, "spent");
  if (spent.kind === "spent") assert.equal(spent.record.remaining, 4);

  // Classification on the same store, so a dev sees the same 404/410 the
  // deployed store answers.
  assert.deepEqual(await store.spendDownloadToken("0".repeat(32), NOW_MS), {
    kind: "missing",
  });
  // The reverse index is rewritten by the spend, which is what keeps a
  // redelivered webhook from minting a second token for the same order.
  const index = JSON.parse(
    (await store.findDownloadToken("cs_test_e2edigitalpaid00000001"))!,
  ) as { remaining: number; token: string };
  assert.equal(index.remaining, 4);
  assert.equal(index.token, "e2ef17e0000000000000000000000aa0");

  const expiredSession = "cs_test_e2edigitalpending000002";
  const expiredAt = Math.floor(NOW_MS / 1000) - 10;
  const expiredRecord = {
    v: 1 as const,
    sessionId: expiredSession,
    expiresAt: expiredAt,
    remaining: 3,
  };
  await store.putDownloadToken(expiredRecord, { ...expiredRecord, token: "1".repeat(32) });
  assert.deepEqual(await store.spendDownloadToken("1".repeat(32), NOW_MS), {
    kind: "expired",
  });

  // Exhausted: a valid, unexpired token that has no downloads left.
  const lastRecord = {
    v: 1 as const,
    sessionId: "cs_test_e2ephysicalawaitingprodigi03",
    expiresAt: Math.floor(NOW_MS / 1000) + 3600,
    remaining: 0,
  };
  await store.putDownloadToken(lastRecord, { ...lastRecord, token: "2".repeat(32) });
  assert.deepEqual(await store.spendDownloadToken("2".repeat(32), NOW_MS), {
    kind: "exhausted",
  });

  // A token whose stored JSON will not parse is missing, not a crash: the seed
  // file is a hand-written fixture, and a bad one must not take the dev server
  // down mid-session.
  const dir = mkdtempSync(join(tmpdir(), "orders-seed-token-"));
  const corrupt = join(dir, "corrupt-token.json");
  writeFileSync(
    corrupt,
    JSON.stringify({ [`dl:${"3".repeat(32)}`]: "{not json" }),
  );
  const store3 = seededOrdersStore(corrupt);
  assert.deepEqual(await store3.spendDownloadToken("3".repeat(32), NOW_MS), {
    kind: "missing",
  });
  assert.deepEqual(await store3.spendDownloadToken("4".repeat(32), NOW_MS), {
    kind: "missing",
  });
});

test("the seeded store's conditional write and query match the port contract", async () => {
  const store = seededOrdersStore(SEED_PATH);
  const SESSION = "cs_test_seedcondwrite0000000001";
  const record = {
    v: 1 as const,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: false,
    status: "paid-unfulfilled" as const,
    photoSlug: "dawn",
    kind: "physical",
    format: "giclee" as const,
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: "prodigi-unavailable",
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-02T12:00:00.000Z",
    createdAt: "2026-10-02T12:00:00.000Z",
    attempts: 1,
    shipments: [],
    emailsSent: [],
  };

  // No row yet, and a stored row whose attempts moved: both must decline.
  assert.equal(
    await store.transitionOrder({ sessionId: SESSION, fromAttempts: 1, record }),
    false,
  );
  await store.putOrder(record);
  assert.equal(
    await store.transitionOrder({ sessionId: SESSION, fromAttempts: 99, record }),
    false,
    "a stale attempts value must not win the lock",
  );
  assert.equal(
    await store.transitionOrder({ sessionId: SESSION, fromAttempts: 1, record: { ...record, reason: null } }),
    true,
  );
  const after = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(after.attempts, 2);

  // Unparseable rows are skipped by the query rather than thrown from it.
  const broken = seededOrdersStore(
    (() => {
      const dir = mkdtempSync(join(tmpdir(), "orders-seed-bad-"));
      const file = join(dir, "bad.json");
      writeFileSync(file, JSON.stringify({ cs_test_e2edigitalpaid00000001: "not json" }));
      return file;
    })(),
  );
  assert.deepEqual(await broken.listOrders({}), []);

  // Each filter is its own predicate, including the reconciler's combined one.
  const withRows = seededOrdersStore(SEED_PATH);
  const retryable = await withRows.listOrders({ retryable: true, limit: 50 });
  assert.ok(retryable.length > 0);
  for (const order of retryable) {
    assert.equal(order.status, "paid-unfulfilled");
    assert.equal(order.terminal, false);
  }
  const revoked = await withRows.listOrders({ revoked: true, limit: 50 });
  for (const order of revoked) {
    assert.ok(order.status === "refunded" || order.status === "disputed");
  }
  const byStatus = await withRows.listOrders({ status: ["paid-unfulfilled"], limit: 50 });
  for (const order of byStatus) assert.equal(order.status, "paid-unfulfilled");
  // The limit is honoured, and the results are oldest-first.
  const capped = await withRows.listOrders({ limit: 1 });
  assert.ok(capped.length <= 1);
});

test("a record written without a createdAt gets updatedAt, and a missing token reads null", async () => {
  // The seed store is the port, not a read-only view: a webhook that runs
  // against a dev server writes through it. Two details have to hold for those
  // writes to be readable back — the createdAt fallback the port documents, and
  // an absent token being null rather than a throw.
  const store = seededOrdersStore(SEED_PATH);
  const SESSION = "cs_test_nocreatedat000000000001";
  const record = {
    v: 1 as const,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: false,
    status: "paid-unfulfilled" as const,
    photoSlug: "dawn",
    kind: "physical",
    format: "giclee" as const,
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: "prodigi-unavailable",
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-02T09:00:00.000Z",
    createdAt: "",
    attempts: 1,
    shipments: [],
    emailsSent: [],
  };
  await store.putOrder(record);
  const written = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(written.createdAt, "2026-10-02T09:00:00.000Z");
  assert.equal(written.attempts, 1);

  // The same fallback on the conditional write, where it keeps the original
  // creation time rather than pretending the retry was the first write.
  assert.equal(
    await store.transitionOrder({ sessionId: SESSION, fromAttempts: 1, record: { ...record, reason: null } }),
    true,
  );
  const retried = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.equal(retried.createdAt, "2026-10-02T09:00:00.000Z");
  assert.equal(retried.attempts, 2);

  assert.equal(await store.getDownloadToken("5".repeat(32)), null);
});

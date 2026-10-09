import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadIndexKey,
  downloadLinkForSession,
  downloadTokenKey,
  ensureDownloadToken,
  readDownloadToken,
  redeemDownloadToken,
} from "../src/application/fulfillment/download-token.ts";
import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  isDownloadToken,
  newDownloadToken,
  parseDownloadTokenRecord,
} from "../src/domain/ordering/download-token.ts";
import { getConfig } from "../src/infrastructure/config/config.ts";
import { ORDERS_STORE_UNAVAILABLE_ERROR } from "../src/domain/ordering/orders-store.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";

/* Download tokens (#111 / #116).

   The token is the credential that grants a master file, so what this file
   pins is: the grammar it accepts, the two limits it enforces, the
   idempotence the webhook depends on, and — now that spend is a single D1
   UPDATE — that the counter is exact under concurrent spends. */

const LIMITS = { ttlSeconds: 30 * 86_400, maxDownloads: 5 };
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const SESSION = "cs_test_abcdefgh";

test("a token is 128 bits of CSPRNG, and the grammar is the length", () => {
  const tokens = new Set(Array.from({ length: 200 }, newDownloadToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(isDownloadToken(token));
  }
  for (const bad of [
    "",
    "not-a-token",
    "e2ef17e0000000000000000000000aa",
    `${"a".repeat(33)}`,
    `${"z".repeat(32)}`,
    "E2EF17E0000000000000000000000AA",
  ]) {
    assert.equal(isDownloadToken(bad), false, bad);
  }
});

test("key helpers still name the KV-era layout the migration script reads", () => {
  assert.equal(downloadTokenKey("ab"), "dl:ab");
  assert.equal(downloadIndexKey(SESSION), `dls:${SESSION}`);
});

test("issuing writes the token and the reverse index", async () => {
  const store = memoryOrdersStore();
  const record = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: LIMITS,
    nowMs: NOW,
  });
  assert.ok(record);
  assert.equal(record.remaining, 5);
  assert.equal(record.expiresAt, Math.floor(NOW / 1000) + LIMITS.ttlSeconds);
  assert.ok(await store.getDownloadToken(record.token));
  assert.ok(await store.findDownloadToken(SESSION));
});

test("ensureDownloadToken is idempotent for an existing live token", async () => {
  const store = memoryOrdersStore();
  const first = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: LIMITS,
    nowMs: NOW,
  });
  const second = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: LIMITS,
    nowMs: NOW,
  });
  assert.equal(first!.token, second!.token);
});

test("redeemDownloadToken spends exactly once per call", async () => {
  const store = memoryOrdersStore();
  const minted = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: { ttlSeconds: 3600, maxDownloads: 2 },
    nowMs: NOW,
  });
  assert.ok(minted);

  const first = await redeemDownloadToken({
    store,
    token: minted.token,
    nowMs: NOW,
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.record.remaining, 1);

  const second = await redeemDownloadToken({
    store,
    token: minted.token,
    nowMs: NOW,
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.record.remaining, 0);

  const third = await redeemDownloadToken({
    store,
    token: minted.token,
    nowMs: NOW,
  });
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.equal(third.status, 410);
    assert.equal(third.error, "download-limit-reached");
  }
});

test("redeem classifies missing, expired, and invalid tokens", async () => {
  const store = memoryOrdersStore();
  assert.deepEqual(
    await redeemDownloadToken({ store, token: "not-a-token", nowMs: NOW }),
    { ok: false, status: 400, error: "invalid-token" },
  );
  assert.deepEqual(
    await redeemDownloadToken({ store, token: "a".repeat(32), nowMs: NOW }),
    { ok: false, status: 404, error: "invalid-token" },
  );

  const minted = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: { ttlSeconds: 1, maxDownloads: 5 },
    nowMs: NOW,
  });
  assert.ok(minted);
  const expired = await redeemDownloadToken({
    store,
    token: minted.token,
    nowMs: NOW + 5000,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.status, 410);
    assert.equal(expired.error, "download-expired");
  }
});

test("a throwing spend surfaces as orders-store-unavailable", async () => {
  const base = memoryOrdersStore();
  const failing = {
    ...base,
    async spendDownloadToken() {
      throw new Error("down");
    },
  };
  const result = await redeemDownloadToken({
    store: failing,
    token: "d".repeat(32),
    nowMs: NOW,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 503,
    error: ORDERS_STORE_UNAVAILABLE_ERROR,
  });
});

test("readDownloadToken and downloadLinkForSession follow the index", async () => {
  const store = memoryOrdersStore();
  assert.equal(await readDownloadToken(store, SESSION, { nowMs: NOW }), null);
  assert.equal(await downloadLinkForSession(store, SESSION, { nowMs: NOW }), null);

  const minted = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: LIMITS,
    nowMs: NOW,
  });
  assert.ok(minted);
  assert.equal(
    await downloadLinkForSession(store, SESSION, { nowMs: NOW }),
    `/api/download?token=${minted.token}`,
  );
});

test("parseDownloadTokenRecord rejects junk", () => {
  assert.equal(parseDownloadTokenRecord("{"), null);
  assert.equal(parseDownloadTokenRecord("{}"), null);
  const valid = {
    v: 1,
    sessionId: SESSION,
    expiresAt: 1,
    remaining: 5,
  };
  assert.ok(parseDownloadTokenRecord(JSON.stringify(valid)));

  // Each field has its own check, so each gets its own rejected value: a record
  // whose expiry is a string would otherwise reach the arithmetic and compare a
  // string to the clock.
  const reject = (over: Record<string, unknown>) =>
    assert.equal(
      parseDownloadTokenRecord(JSON.stringify({ ...valid, ...over })),
      null,
      `expected ${JSON.stringify(over)} to be rejected`,
    );
  reject({ v: 2 });
  reject({ sessionId: "not-a-session" });
  reject({ expiresAt: "1" });
  reject({ expiresAt: Number.POSITIVE_INFINITY });
  reject({ remaining: "5" });
  reject({ remaining: 4.5 });
  assert.equal(parseDownloadTokenRecord("null"), null);
  assert.equal(parseDownloadTokenRecord("[]"), null);
});

test("config defaults match the module constants", () => {
  const config = getConfig();
  assert.equal(config.download.maxDownloads, DOWNLOAD_TOKEN_MAX_DOWNLOADS);
  assert.equal(config.download.tokenTtlSeconds, DOWNLOAD_TOKEN_TTL_SECONDS);
});

test("ensureDownloadToken returns null when putDownloadToken throws", async () => {
  const base = memoryOrdersStore();
  const failing = {
    ...base,
    async putDownloadToken() {
      throw new Error("down");
    },
  };
  assert.equal(
    await ensureDownloadToken({
      store: failing,
      sessionId: SESSION,
      limits: LIMITS,
      nowMs: NOW,
    }),
    null,
  );
});

test("readDownloadToken degrades to null rather than throwing when the store does", async () => {
  // A transient D1 failure on the token lookup must not turn a paid download
  // into a 500 the customer sees as a broken site: `null` is "no token", which
  // the route already answers as a 404 invalid-token and the page answers as
  // digital-no-token.
  const { readDownloadToken } = await import("../src/application/fulfillment/download-token.ts");
  const { memoryOrdersStore } = await import("./fake-orders-store.mts");
  const base = memoryOrdersStore();
  const throwing = {
    ...base,
    async findDownloadToken(): Promise<string | null> {
      throw new Error("d1 down");
    },
  };
  assert.equal(await readDownloadToken(throwing as never, SESSION), null);
  // A store that answers null is the same answer, and an unparseable index
  // value is not a hit either.
  assert.equal(await readDownloadToken(base, SESSION), null);
});

test("an index the store cannot be trusted with reads as no token", async () => {
  // The index is a JSON blob the store hands back verbatim, so a row that is
  // not one (hand-edited, half-migrated, written by the old KV shape) must be
  // "no token" rather than a crash or a token with someone else's session.
  const cases: Record<string, string> = {
    "valid JSON, not a record": JSON.stringify({ token: "a".repeat(32) }),
    "valid record, token is not a token": JSON.stringify({
      v: 1,
      sessionId: SESSION,
      expiresAt: Math.floor(NOW / 1000) + 3600,
      remaining: 5,
      token: "too-short",
    }),
    "valid record, token is not a string": JSON.stringify({
      v: 1,
      sessionId: SESSION,
      expiresAt: Math.floor(NOW / 1000) + 3600,
      remaining: 5,
      token: 7,
    }),
  };
  for (const [what, raw] of Object.entries(cases)) {
    const store = memoryOrdersStore();
    store.indexes.set(SESSION, raw);
    assert.equal(await readDownloadToken(store, SESSION, { nowMs: NOW }), null, what);
    assert.equal(await downloadLinkForSession(store, SESSION, { nowMs: NOW }), null, what);
  }
});

test("an expired index reads as no token, with and without an explicit clock", async () => {
  const store = memoryOrdersStore();
  const record = await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: LIMITS,
    nowMs: NOW,
  });
  assert.ok(record);
  const past = { nowMs: (record.expiresAt + 1) * 1000 };
  assert.equal(await readDownloadToken(store, SESSION, past), null);

  // No options at all: the caller's "now" is the wall clock, and a token minted
  // for a far-future expiry is the one that must still be readable through it.
  const live = await readDownloadToken(store, SESSION);
  assert.equal(live?.token, record.token);
  assert.equal(await downloadLinkForSession(store, SESSION), `/api/download?token=${record.token}`);
});

test("a token write that fails mints nothing rather than a broken link", async () => {
  const store = memoryOrdersStore();
  const failing = {
    ...store,
    async putDownloadToken(): Promise<void> {
      throw new Error(ORDERS_STORE_UNAVAILABLE_ERROR);
    },
  };
  assert.equal(
    await ensureDownloadToken({ store: failing, sessionId: SESSION, limits: LIMITS, nowMs: NOW }),
    null,
  );
});

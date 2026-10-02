import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  downloadIndexKey,
  downloadLinkForSession,
  downloadTokenKey,
  ensureDownloadToken,
  isDownloadToken,
  newDownloadToken,
  parseDownloadTokenRecord,
  readDownloadToken,
  redeemDownloadToken,
} from "../src/lib/download-token.ts";
import { getConfig } from "../src/lib/config.ts";

/* Download tokens (#111).

   The token is the credential that grants a master file, so what this file
   pins is: the grammar it accepts, the two limits it enforces, and the
   idempotence the webhook depends on. What it deliberately does *not* pin is
   atomicity — KV has no compare-and-swap, so `remaining` is advisory and the
   counter is expected to err toward serving. A test asserting exactness here
   would be asserting something the store cannot deliver. */

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  ttls: Map<string, number | undefined>;
  writes: number;
};

function memoryKv(initial: Record<string, string> = {}): Kv {
  const store = new Map(Object.entries(initial));
  const ttls = new Map<string, number | undefined>();
  return {
    ttls,
    writes: 0,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value, options) {
      this.writes++;
      ttls.set(key, options?.expirationTtl);
      store.set(key, value);
    },
  };
}

const LIMITS = { ttlSeconds: 30 * 86_400, maxDownloads: 5 };
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

test("a token is 128 bits of CSPRNG, and the grammar is the length", () => {
  const tokens = new Set(Array.from({ length: 200 }, newDownloadToken));
  // Distinct, because a repeated token would hand one buyer another's file.
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(isDownloadToken(token));
  }
  // Short, long and non-hex spellings are all refused, and the length is the
  // whole rule — so there is exactly one shape to store and one to compare.
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

test("issuing writes both keys, with a KV TTL just under the token's own", async () => {
  const kv = memoryKv();
  const record = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  assert.ok(record);
  assert.equal(record.remaining, LIMITS.maxDownloads);
  assert.equal(record.expiresAt, Math.floor(NOW / 1000) + LIMITS.ttlSeconds);

  // The `dl:` value is the record without the token; the `dls:` index carries
  // it, because that is the only way to get from a session id back to a link.
  assert.deepEqual(JSON.parse((await kv.get(downloadTokenKey(record.token)))!), {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: record.expiresAt,
    remaining: LIMITS.maxDownloads,
  });
  assert.equal(
    (await kv.get(downloadIndexKey("cs_test_abcdefgh")))!,
    JSON.stringify(record),
  );
  // Both expire, and both a second before `expiresAt` so the record cannot be
  // read in the window where the two disagree.
  assert.equal(kv.ttls.get(downloadTokenKey(record.token)), LIMITS.ttlSeconds - 1);
  assert.equal(kv.ttls.get(downloadIndexKey("cs_test_abcdefgh")), LIMITS.ttlSeconds - 1);
});

test("issuing is idempotent: a second call reuses the live token", async () => {
  // The webhook can be redelivered, and fulfillment calls this from both the
  // write path and the duplicate path. Minting afresh each time would leave the
  // first token valid and unfindable — a link the customer never receives.
  const kv = memoryKv();
  const first = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  const writesAfterFirst = kv.writes;
  const second = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  assert.equal(second!.token, first!.token);
  assert.equal(kv.writes, writesAfterFirst, "no second mint");
});

test("an expired token is replaced rather than reused", async () => {
  const kv = memoryKv();
  await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  const later = await ensureDownloadToken({
    kv,
    sessionId: "cs_test_abcdefgh",
    limits: LIMITS,
    nowMs: NOW + 31 * 86_400_000,
  });
  assert.equal(later!.expiresAt, Math.floor((NOW + 31 * 86_400_000) / 1000) + LIMITS.ttlSeconds);
});

test("the token record is validated, including the session id it names", async () => {
  const good = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: 1_800_000_000,
    remaining: 3,
  });
  assert.deepEqual(parseDownloadTokenRecord(good), {
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: 1_800_000_000,
    remaining: 3,
  });

  // A token record naming an arbitrary session is a way to ask for any order's
  // file, so the id goes through the real Checkout Session grammar.
  const foreign = JSON.stringify({ ...JSON.parse(good), sessionId: "../../etc/passwd" });
  assert.equal(parseDownloadTokenRecord(foreign), null);

  for (const bad of [
    "not json",
    JSON.stringify({ ...JSON.parse(good), v: 2 }),
    JSON.stringify({ ...JSON.parse(good), expiresAt: "soon" }),
    JSON.stringify({ ...JSON.parse(good), remaining: 1.5 }),
    JSON.stringify({ ...JSON.parse(good), remaining: "3" }),
  ]) {
    assert.equal(parseDownloadTokenRecord(bad), null, bad);
  }

  // A count that went negative is clamped rather than trusted: the comparison
  // downstream is `<= 0`, and a stored -1 that reads as "one left" would be a
  // record written by nothing this code ships.
  assert.equal(
    parseDownloadTokenRecord(JSON.stringify({ ...JSON.parse(good), remaining: -2 }))!
      .remaining,
    0,
  );
});

test("the index must name the session it is filed under", async () => {
  // A stale index left behind by a moved or copied record would otherwise hand
  // one buyer the link meant for another.
  const kv = memoryKv({
    [downloadIndexKey("cs_test_abcdefgh")]: JSON.stringify({
      v: 1,
      sessionId: "cs_test_someoneelse",
      expiresAt: 1_800_000_000,
      remaining: 5,
      token: "a".repeat(32),
    }),
  });
  assert.equal(await readDownloadToken(kv, "cs_test_abcdefgh", { nowMs: NOW }), null);
  assert.equal(await downloadLinkForSession(kv, "cs_test_abcdefgh", { nowMs: NOW }), null);
});

test("the link carries the token and nothing else", async () => {
  const kv = memoryKv();
  const record = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  assert.equal(
    await downloadLinkForSession(kv, "cs_test_abcdefgh", { nowMs: NOW }),
    `/api/download?token=${record!.token}`,
  );
  // An index without a token cannot produce a link, rather than producing one
  // with `token=undefined` in it.
  const withoutToken: Record<string, unknown> = { ...record! };
  delete withoutToken.token;
  await kv.put(
    downloadIndexKey("cs_test_abcdefgh"),
    JSON.stringify(withoutToken),
  );
  assert.equal(await downloadLinkForSession(kv, "cs_test_abcdefgh", { nowMs: NOW }), null);
});

test("a KV that throws is a miss on the read path and a 503 on the redeem path", async () => {
  const throwing = {
    async get() {
      throw new Error("kv down");
    },
    async put() {},
  };
  const record = JSON.stringify({
    v: 1,
    sessionId: "cs_test_abcdefgh",
    expiresAt: 1_800_000_000,
    remaining: 1,
  });
  await throwing.put(downloadTokenKey("a".repeat(32)), record);
  assert.equal(await readDownloadToken(throwing, "cs_test_abcdefgh", { nowMs: NOW }), null);
  // The redeem path is on a request that has nowhere to go but an error page,
  // so a store outage answers 503 rather than looking like a bad token.
  const redeemed = await redeemDownloadToken({
    kv: throwing,
    token: "a".repeat(32),
    nowMs: NOW,
  });
  assert.equal(redeemed.ok, false);
});

test("redeeming spends exactly one download per request", async () => {
  const kv = memoryKv();
  const record = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: { ...LIMITS, maxDownloads: 2 }, nowMs: NOW });
  const token = record!.token;

  const first = await redeemDownloadToken({ kv, token, nowMs: NOW });
  assert.equal(first.ok, true);
  assert.equal(await kv.get(downloadTokenKey(token)).then((raw) => JSON.parse(raw!).remaining), 1);

  // The index carries the decremented count too, or the success page would keep
  // offering a link whose balance is gone.
  const index = JSON.parse((await kv.get(downloadIndexKey("cs_test_abcdefgh")))!);
  assert.equal(index.remaining, 1);
  assert.equal(index.token, token);

  const second = await redeemDownloadToken({ kv, token, nowMs: NOW });
  assert.equal(second.ok, true);
  const third = await redeemDownloadToken({ kv, token, nowMs: NOW });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.status, 410);
  assert.equal(third.ok === false && third.error, "download-limit-reached");
});

test("expiry is checked before the counter", async () => {
  const kv = memoryKv();
  const record = await ensureDownloadToken({ kv, sessionId: "cs_test_abcdefgh", limits: LIMITS, nowMs: NOW });
  const spent = await redeemDownloadToken({
    kv,
    token: record!.token,
    nowMs: NOW + LIMITS.ttlSeconds * 1000,
  });
  // Plenty of downloads left, and still refused: "expired" is the answer the
  // customer can act on, "limit reached" is not.
  assert.equal(spent.ok, false);
  assert.equal(spent.ok === false && spent.error, "download-expired");
});

test("redeeming an unknown or malformed token never spends anything", async () => {
  const kv = memoryKv();
  for (const [token, status, error] of [
    ["nope", 400, "invalid-token"],
    ["a".repeat(32), 404, "invalid-token"],
  ] as const) {
    const result = await redeemDownloadToken({ kv, token, nowMs: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, status, token);
    assert.equal(result.ok === false && result.error, error, token);
  }
  assert.equal(kv.writes, 0, "a rejected token must not write to the store");
});

test("a token record that is not the stored shape is refused, not served", async () => {
  const kv = memoryKv();
  const token = "c".repeat(32);
  // Present under the right key, unreadable as a record. This is the shape a
  // half-written or hand-edited KV value takes, and it must read as "no such
  // token" rather than falling through to an order read with a null session.
  for (const raw of ["not json", JSON.stringify({ v: 1, sessionId: 42 }), JSON.stringify([1, 2])]) {
    await kv.put(downloadTokenKey(token), raw);
    const result = await redeemDownloadToken({ kv, token, nowMs: NOW });
    assert.equal(result.ok, false, raw);
    assert.equal(result.ok === false && result.status, 404, raw);
  }
  assert.equal(kv.writes, 0);
});

test("a store that fails while spending answers 503, not a served file", async () => {
  // The read succeeded, so the failure is on the write that records the spend.
  // Answering "served" here would hand out a file with no decrement recorded.
  const kv = memoryKv({
    [downloadTokenKey("d".repeat(32))]: JSON.stringify({
      v: 1,
      sessionId: "cs_test_abcdefgh",
      expiresAt: 1_800_000_000,
      remaining: 2,
    }),
  });
  const failing = {
    async get(key: string) {
      return kv.get(key);
    },
    async put() {
      throw new Error("kv write down");
    },
  };
  const result = await redeemDownloadToken({ kv: failing, token: "d".repeat(32), nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 503);
  // The stored count is untouched: a failed spend must not consume a download.
  const stored = JSON.parse((await kv.get(downloadTokenKey("d".repeat(32))))!);
  assert.equal(stored.remaining, 2);
});

test("the limits are configurable, and a bad value falls back to the default", () => {
  // Policy, not credentials: unset means the documented defaults rather than
  // "unlimited" or "already expired".
  assert.equal(DOWNLOAD_TOKEN_TTL_SECONDS, 30 * 86_400);
  assert.equal(DOWNLOAD_TOKEN_MAX_DOWNLOADS, 5);

  const configured = getConfig({
    DOWNLOAD_TOKEN_TTL_SECONDS: "3600",
    DOWNLOAD_TOKEN_MAX_DOWNLOADS: "1",
  }).download;
  assert.deepEqual(configured, { tokenTtlSeconds: 3600, maxDownloads: 1 });

  for (const bad of ["", "  ", "many", "-1", "0", "1.5", "99999999999999999999"]) {
    assert.deepEqual(
      getConfig({ DOWNLOAD_TOKEN_TTL_SECONDS: bad, DOWNLOAD_TOKEN_MAX_DOWNLOADS: bad }).download,
      { tokenTtlSeconds: 30 * 86_400, maxDownloads: 5 },
      bad,
    );
  }
});
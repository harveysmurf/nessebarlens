import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyKvKey,
  describeCorruptOrder,
  looksLikeOrderRecord,
  migrateKvMap,
  orderInsertSql,
  tokenInsertSql,
} from "../scripts/migrate-orders-kv-to-d1.mjs";
// Same reasoning as the operator view's test: the bind renderer and the
// download cap are read from the modules that own them, not re-exported here.
import { sqlWithBinds } from "../scripts/sql-binds.mjs";
import { DOWNLOAD_TOKEN_MAX_DOWNLOADS } from "../src/lib/download-token.ts";

const SESSION = "cs_test_abcdefgh";
const ORDER = JSON.stringify({
  v: 1,
  sessionId: SESSION,
  status: "paid",
  terminal: true,
  updatedAt: "2026-10-01T00:00:00.000Z",
});

test("migrate emits parameterised INSERT … ON CONFLICT SQL", () => {
  assert.match(orderInsertSql(false), /ON CONFLICT\(session_id\) DO NOTHING/);
  assert.match(orderInsertSql(true), /DO UPDATE SET/);
  assert.match(tokenInsertSql(false), /ON CONFLICT\(token\) DO NOTHING/);
  const sql = orderInsertSql(false);
  const binds = [SESSION, ORDER, "paid", 1, null, 1, "t", "t"];
  const rendered = sqlWithBinds(sql, binds);
  assert.ok(rendered.includes(`'${SESSION}'`));
  assert.ok(!rendered.includes("?"));
});

test("corrupt order records are reported and not inserted", () => {
  const { statements, tally, corruptReports } = migrateKvMap({
    [SESSION]: "{not-json",
    [`dl:${"a".repeat(32)}`]: JSON.stringify({
      v: 1,
      sessionId: SESSION,
      expiresAt: 4102444800,
      remaining: 3,
    }),
    [`dls:${SESSION}`]: JSON.stringify({
      v: 1,
      sessionId: SESSION,
      expiresAt: 4102444800,
      remaining: 3,
      token: "a".repeat(32),
    }),
  });
  assert.equal(tally.corrupt, 1);
  assert.equal(statements.filter((s) => s.kind === "order").length, 0);
  assert.equal(tally.tokensMigrated, 1);
  assert.equal(corruptReports[0]!.sessionId, SESSION);
  assert.equal(looksLikeOrderRecord(ORDER, SESSION), true);
  assert.equal(looksLikeOrderRecord("{", SESSION), false);
  assert.deepEqual(describeCorruptOrder("{", SESSION).json, false);
  assert.equal(classifyKvKey(`dl:${"a".repeat(32)}`).kind, "token");
  assert.equal(DOWNLOAD_TOKEN_MAX_DOWNLOADS, 5);
});

test("a valid order is queued for insert", () => {
  const { statements, tally } = migrateKvMap({ [SESSION]: ORDER });
  assert.equal(tally.inserted, 1);
  assert.equal(statements.length, 1);
  assert.equal(statements[0]!.kind, "order");
});

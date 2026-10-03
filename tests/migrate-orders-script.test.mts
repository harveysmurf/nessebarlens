import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyKvKey,
  describeCorruptOrder,
  looksLikeOrderRecord,
  migrateKvMap,
  orderInsertSql,
  runMigrate,
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

/**
 * The two properties below are the ones a production run depends on and unit
 * tests over the pure path cannot see: that the KV read reaches the remote
 * namespace, and that an empty read fails instead of reporting success. Both
 * were found by running the commands against the real account, where the
 * no---remote form listed zero keys and the script would have exited 0 having
 * moved nothing.
 */
function recordingSpawn(calls) {
  return (_cmd, args) => {
    calls.push(args);
    return { status: 1, stdout: "", stderr: "stop-before-network" };
  };
}

test("the KV read passes --remote so it cannot resolve to local storage", () => {
  const calls = [];
  // listKv throws on a non-zero status, so runMigrate unwinds at the first
  // call; the args recorded up to that point are the assertion.
  try {
    runMigrate([], { spawnSync: recordingSpawn(calls) });
  } catch {
    // the fake refuses to answer; the recorded arguments are the subject
  }
  assert.ok(calls.length > 0, "expected the script to shell out to wrangler");
  for (const args of calls) {
    assert.ok(
      args.includes("--remote"),
      `wrangler kv invocation must be explicit about the remote store: ${args.join(" ")}`,
    );
  }
});

test("an empty KV read fails instead of reporting a successful zero-row migration", () => {
  const calls = [];
  const result = runMigrate([], {
    spawnSync: (_cmd, args) => {
      calls.push(args);
      // Only the key list is answered; a get must never be reached.
      if (args.includes("list")) return { status: 0, stdout: "[]", stderr: "" };
      throw new Error(`unexpected second call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /refusing to report a successful zero-row migration/);
  assert.equal(
    calls.filter((a) => a.includes("get")).length,
    0,
    "an empty listing must short-circuit before any per-key get",
  );
});

test("a successful run still exits 0 and reports its tally", () => {
  const result = runMigrate([], {
    listKv: () => [SESSION],
    getKv: () => ORDER,
    executeD1: () => ({ ok: true, changes: 1 }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.tally.inserted, 1);
  assert.equal(result.tally.corrupt, 0);
});

/**
 * The migrated schema must be the schema `src/lib/orders-d1.ts` queries (#203).
 *
 * Before this, the orders tests ran against `tests/fake-d1.mts`, which matched
 * statements by substring and answered from Maps. A migration could rename or
 * drop a column, or the store could misspell one, and every test stayed green —
 * the mismatch only showed up in production on the money path. These tests make
 * the schema the real one and compile the store's own SQL against it: SQLite
 * resolves table and column names at prepare time, so a misspelled column here,
 * or a migration that removes a column the code reads, fails immediately.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sqliteD1, loadMigrations } from "./sqlite-d1.mts";
import { ORDER_SQL } from "../src/lib/orders-d1.ts";

test("every migration applies to a fresh database and creates the store's tables", () => {
  const db = sqliteD1();
  const tables = db
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
    .map((row) => row.name);
  for (const table of ["orders", "download_tokens", "prodigi_callbacks"]) {
    assert.ok(
      tables.includes(table),
      `the migration set must create the ${table} table the store queries`,
    );
  }
  assert.ok(
    loadMigrations().length >= 2,
    "loadMigrations must find the SQL files, or this test checks nothing",
  );
});

test("every statement the store issues compiles against the migrated schema", () => {
  // One entry per ORDER_SQL constant. If any of these throws, the store names a
  // table or column the migrations do not create — the exact class of bug the
  // fake D1 could never catch.
  const db = sqliteD1();
  const statements: Record<string, string> = {
    getOrder: ORDER_SQL.getOrder,
    putOrder: ORDER_SQL.putOrder,
    transitionOrder: ORDER_SQL.transitionOrder,
    list: ORDER_SQL.list(""),
    getDownloadToken: ORDER_SQL.getDownloadToken,
    putDownloadToken: ORDER_SQL.putDownloadToken,
    findDownloadToken: ORDER_SQL.findDownloadToken,
    claimProdigiCallback: ORDER_SQL.claimProdigiCallback,
    spendDownloadToken: ORDER_SQL.spendDownloadToken,
    getTokenState: ORDER_SQL.getTokenState,
  };
  for (const [name, sql] of Object.entries(statements)) {
    assert.doesNotThrow(
      () => db.compile(sql),
      `${name} must compile against the migrated schema`,
    );
  }
});

test("the list query compiles with each filter clause the store builds", () => {
  // listOrdersQuery interpolates a WHERE built from the filter, so the clauses
  // are checked here too, not just the empty-`where` base.
  const db = sqliteD1();
  for (const where of [
    "",
    "WHERE status = ? AND terminal = 0",
    "WHERE status IN (?, ?)",
    "WHERE status IN (?, ?, ?)",
  ]) {
    assert.doesNotThrow(
      () => db.compile(ORDER_SQL.list(where)),
      `list query must compile for where=${JSON.stringify(where)}`,
    );
  }
});

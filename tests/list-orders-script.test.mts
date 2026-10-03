import assert from "node:assert/strict";
import test from "node:test";
import {
  buildListOrdersSql,
  clampLimit,
  formatTable,
  parseArgs,
  extractRows,
} from "../scripts/list-orders.mjs";
// From the owner, not through the script: a re-export would put the quoting
// rules back under two names, which is the duplication the grammar gate
// refuses. The script and the test both reach the one declaration.
import { sqlWithBinds } from "../scripts/sql-binds.mjs";

test("list-orders builds a parameterised query and never interpolates raw status", () => {
  const all = buildListOrdersSql({ status: "all", limit: 10 });
  assert.match(all.sql, /LIMIT \?/);
  assert.ok(!all.sql.includes("paid-unfulfilled"));
  assert.deepEqual(all.binds, [10]);

  const filtered = buildListOrdersSql({ status: "paid-unfulfilled", limit: 5 });
  assert.match(filtered.sql, /WHERE status = \?/);
  assert.deepEqual(filtered.binds, ["paid-unfulfilled", 5]);
  assert.equal(
    sqlWithBinds(filtered.sql, filtered.binds),
    "SELECT session_id, status, reason, attempts, created_at, updated_at, record FROM orders WHERE status = 'paid-unfulfilled' ORDER BY created_at ASC LIMIT 5",
  );
});

test("list-orders rejects unknown status and clamps limit", () => {
  assert.throws(() => buildListOrdersSql({ status: "nope" }), /unknown --status/);
  assert.equal(clampLimit(0), 100);
  assert.equal(clampLimit(9999), 500);
  assert.deepEqual(parseArgs(["--status", "paid", "--limit", "3"]), {
    status: "paid",
    limit: "3",
    help: false,
  });
});

test("formatTable and extractRows tolerate wrangler shapes", () => {
  const rows = extractRows([{ results: [{ session_id: "cs_test_a", status: "paid", reason: null, attempts: 1, created_at: "2026-10-01T00:00:00.000Z", record: "{\"format\":\"digital\",\"photoSlug\":\"dawn\",\"amountTotal\":3000}" }] }]);
  assert.equal(rows.length, 1);
  const table = formatTable(rows, Date.parse("2026-10-02T00:00:00.000Z"));
  assert.match(table, /cs_test_a/);
  assert.match(table, /digital/);
});

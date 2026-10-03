import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultListNamespaceIds,
  findUnmigratedOrderKeys,
  KV_BINDING,
  parseCount,
  parseD1Sessions,
  parseOrdersKvBinding,
  removeOrdersKvBinding,
  runRemove,
} from "../scripts/remove-orders-kv.mjs";

const TOML = [
  'name = "nessebar-lens"',
  "",
  "# Migration only (#116). The application reads ORDERS_DB (D1), not this KV",
  "# namespace. Keep the binding until `npm run migrate:orders` has run against",
  "# production — deleting it earlier loses the source data the migration reads",
  "# through the wrangler CLI.",
  "[[kv_namespaces]]",
  'binding = "ORDERS"',
  'id = "c6f34450a61c4c69b3f840e845a7b0d3"',
  'preview_id = "849af920ace64914904b2799bd0fc073"',
  "",
  "[[d1_databases]]",
  'binding = "ORDERS_DB"',
  'database_name = "nessebar-lens-orders"',
  "",
  "[[r2_buckets]]",
  'binding = "WEB"',
  "",
].join("\n");

const sessions = (n) => Array.from({ length: n }, (_, i) => `cs_test_${String(i).padStart(8, "0")}`);
// A value the migrator accepts as a completed order.
const orderValue = (sessionId) =>
  JSON.stringify({
    v: 1,
    sessionId,
    status: "paid",
    terminal: true,
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
// Pre-payment placeholders: cs_ keys, because that is what checkout writes
// before payment, but not order records. The gate must not treat these as
// unmigrated orders, and must not need to fetch them to know that.
const placeholders = [sessions(5)[0], sessions(5)[1]];
const placeholderValue = (sessionId) => JSON.stringify({ sessionId, status: "open" });
const TOKEN_KEY = `dl:${"a".repeat(32)}`;

/**
 * The steady state: `n` order records migrated into D1, plus state that is not
 * an order at all (two placeholders in the preview namespace, a download token
 * in production). The value a key returns is derived from the key, so a test
 * only has to say which sessions D1 has.
 */
const gate = (n, { prod = sessions(n) } = {}) => ({
  listKvKeys: (_spawn, id) => (id === PROD_ID ? [...prod, TOKEN_KEY] : [...placeholders]),
  getKvValue: (_spawn, _id, key) =>
    placeholders.includes(key) ? placeholderValue(key) : orderValue(key),
  listD1Sessions: () => sessions(n),
});
const PROD_ID = "c6f34450a61c4c69b3f840e845a7b0d3";
const PREVIEW_ID = "849af920ace64914904b2799bd0fc073";
const ALL_IDS = [PROD_ID, PREVIEW_ID];

test("the ORDERS kv block is located with both namespace ids", () => {
  const found = parseOrdersKvBinding(TOML);
  assert.ok(found);
  assert.equal(found.id, "c6f34450a61c4c69b3f840e845a7b0d3");
  assert.equal(found.previewId, "849af920ace64914904b2799bd0fc073");
});

test("a different kv binding is not ours to remove", () => {
  const other = TOML.replace('binding = "ORDERS"', 'binding = "SOMETHING_ELSE"');
  assert.equal(parseOrdersKvBinding(other), null);
});

test("removing the block takes its comment and leaves everything else byte-identical", () => {
  const { text, removed } = removeOrdersKvBinding(TOML);
  assert.equal(removed, true);
  assert.equal(parseOrdersKvBinding(text), null);
  assert.ok(!text.includes("c6f34450a61c4c69b3f840e845a7b0d3"));
  assert.ok(!text.includes("Migration only (#116)"));
  assert.ok(text.includes('name = "nessebar-lens"'));
  assert.ok(text.includes("[[d1_databases]]"));
  assert.ok(text.includes('binding = "WEB"'));
  // The real file must survive the rewrite with only the block gone.
  const real = readFileSync("wrangler.toml", "utf8");
  const edited = removeOrdersKvBinding(real);
  assert.equal(edited.removed, true);
  assert.equal(edited.text, real.replace(/# Migration only \(#116\)[\s\S]*?849af920ace64914904b2799bd0fc073"\n\n/, ""));
});

test("counts are read from wrangler's result shape and never guessed", () => {
  assert.equal(parseCount('[{"results":[{"n":5}],"success":true}]'), 5);
  assert.equal(parseCount('[{"results":[{"count":0}]}]'), 0);
  assert.equal(parseCount("[]"), null);
  assert.equal(parseCount("not json"), null);
  assert.equal(parseCount('[{"results":[{"n":"5"}]}]'), null);
});

test("an order in KV with no D1 row refuses, names it, and deletes nothing", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove([], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listNamespaceIds: () => ALL_IDS,
    ...gate(4, { prod: sessions(5) }),
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /gate failed: 1 KV key\(s\) hold a completed order with no row in D1/);
  assert.match(result.stderr, new RegExp(sessions(5)[4]));
  assert.deepEqual(deletes, []);
  assert.deepEqual(writes, []);
});

test("pre-payment placeholders and download tokens are not unmigrated orders", () => {
  // The bug that made the old count-parity gate unsatisfiable: cs_ keys exist
  // for checkouts that never completed, so comparing key counts against D1 rows
  // compared two sets that differ by construction.
  const fetched = [];
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: () => {},
    listNamespaceIds: () => ALL_IDS,
    listKvKeys: (_spawn, id) => (id === PROD_ID ? [...placeholders, TOKEN_KEY] : [...placeholders]),
    getKvValue: (_spawn, id, key) => {
      fetched.push([id, key]);
      return placeholderValue(key);
    },
    listD1Sessions: () => [],
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(deletes, ALL_IDS);
  assert.ok(
    !fetched.some(([, key]) => key === TOKEN_KEY),
    "a download token is never an order, so its value is never fetched",
  );
  assert.match(result.stdout, /"d1Orders":0,"kvKeys":5,"unmigratedOrders":0/);
});

test("an order in the preview namespace alone still refuses", () => {
  // A gate that only reads production is a gate with a hole: the preview
  // namespace is written by the same worker path.
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listNamespaceIds: () => ALL_IDS,
    listKvKeys: (_spawn, id) => (id === PROD_ID ? [] : ["cs_test_ghostsession"]),
    getKvValue: () => orderValue("cs_test_ghostsession"),
    listD1Sessions: () => [],
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /cs_test_ghostsession/);
  assert.deepEqual(deletes, []);
});

test("a clean check without --yes refuses and deletes nothing", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove([], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listNamespaceIds: () => ALL_IDS,
    ...gate(5),
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--yes was not passed/);
  assert.deepEqual(deletes, []);
  assert.deepEqual(writes, []);
});

test("a clean check with --yes deletes both namespaces then rewrites wrangler.toml", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listNamespaceIds: () => ALL_IDS,
    ...gate(5),
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(deletes, [PROD_ID, PREVIEW_ID]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "wrangler.toml");
  assert.equal(parseOrdersKvBinding(writes[0][1]), null);
  assert.equal(result.bindingRemoved, true);
});

test("an unreadable D1 result is a failed gate, not an empty set", () => {
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listNamespaceIds: () => ALL_IDS,
    listKvKeys: () => assert.fail("must not read KV once the D1 side is unknown"),
    getKvValue: () => assert.fail("must not fetch values once the D1 side is unknown"),
    listD1Sessions: () => null,
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown set of sessions/);
  assert.deepEqual(deletes, []);
});

test("D1 sessions are read from wrangler's result shape and never guessed", () => {
  assert.deepEqual(parseD1Sessions('[{"results":[{"session_id":"cs_test_abcdefgh"}],"success":true}]'), [
    "cs_test_abcdefgh",
  ]);
  assert.deepEqual(parseD1Sessions("[]"), []);
  // Anything we cannot read as a session id is unknown, not empty: an empty set
  // would flag every KV order as unmigrated, which is safe, but a reshaped
  // result read as empty hides that the check never ran.
  for (const stdout of ['{"results":[]}', "[{}", '[{"results":[{"n":3}]}]', "not json"]) {
    assert.equal(parseD1Sessions(stdout), null, stdout);
  }
});

test("findUnmigratedOrderKeys reuses the migrator's own grammar", () => {
  const fetched = [];
  const unmigrated = findUnmigratedOrderKeys({
    keys: [...sessions(2), "dl:token", "dls:index", "some-other-key", TOKEN_KEY],
    readValue: (key) => {
      fetched.push(key);
      return orderValue(key);
    },
    d1Sessions: [sessions(0)],
  });
  assert.deepEqual(unmigrated, sessions(2));
  assert.deepEqual(fetched, sessions(2), "non-order keys are never fetched");
});

test("a failed namespace delete leaves wrangler.toml alone", () => {
  const writes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listNamespaceIds: () => ALL_IDS,
    ...gate(5),
    deleteNamespace: (_spawn, id) => {
      if (id.startsWith("849")) throw new Error("delete failed for " + id);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wrangler.toml was NOT rewritten/);
  assert.deepEqual(writes, []);
});

test("delete succeeded but the rewrite died: a re-run finishes the rewrite", () => {
  // The inverse of the delete-fails case, and the one Architect gated on: the
  // namespaces are gone, so a re-run must reach the rewrite instead of dying on
  // a gate it can never satisfy.
  const writes = [];
  const deletes = [];
  // The rewrite failure surfaces as a throw; the CLI's entrypoint turns that
  // into exit 1. What matters here is the state it leaves behind.
  assert.throws(
    () =>
      runRemove(["--yes"], {
        readFileSync: () => TOML,
        writeFileSync: () => {
          throw new Error("disk full");
        },
        listNamespaceIds: () => ALL_IDS,
        ...gate(5),
        deleteNamespace: (_spawn, id) => deletes.push(id),
      }),
    /disk full/,
  );
  assert.deepEqual(deletes, ALL_IDS, "the first run deleted both namespaces");

  const result = runRemove([], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    // Both namespaces are gone now, so a KV read would throw — exactly the
    // state that used to strand the operator.
    listNamespaceIds: () => [],
    listKvKeys: () => assert.fail("must not read KV against a deleted namespace"),
    getKvValue: () => assert.fail("must not fetch a value on a restart"),
    listD1Sessions: () => assert.fail("must not read D1 on a restart"),
    deleteNamespace: (_spawn, id) => assert.fail("must not delete again: " + id),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /already deleted/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "wrangler.toml");
  assert.equal(parseOrdersKvBinding(writes[0][1]), null);
});

test("one namespace gone and one present is refused as half-removed", () => {
  // Deleting the survivor on a gate that can only see the survivor is the one
  // shape that loses data silently, so the half state names itself instead.
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listNamespaceIds: () => [PROD_ID],
    ...gate(5),
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /half-removed/);
  assert.match(result.stderr, new RegExp(PROD_ID));
  assert.deepEqual(deletes, []);
});

test("an absent binding is refused instead of reported as already done", () => {
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML.replace('binding = "ORDERS"', 'binding = "OTHER"'),
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listNamespaceIds: () => ALL_IDS,
    ...gate(5),
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /nothing for this script to remove/);
  assert.deepEqual(deletes, []);
});

test("the KV read passes --remote so the gate cannot measure local storage", () => {
  const calls = [];
  try {
    runRemove(["--yes"], {
      readFileSync: () => TOML,
      writeFileSync: () => {},
      spawnSync: (_cmd, args) => {
        calls.push(args);
        return { status: 1, stdout: "", stderr: "stop-before-network" };
      },
    });
  } catch {
    // the fake refuses to answer; the recorded arguments are the subject
  }
  assert.ok(calls.length > 0, "expected the script to shell out to wrangler");
  for (const args of calls) {
    // `kv namespace list` is account-wide and takes no --remote; it is only an
    // existence probe, and it never reads data.
    if (args.includes("namespace")) continue;
    assert.ok(
      args.includes("--remote"),
      `wrangler must be explicit about the remote store: ${args.join(" ")}`,
    );
  }
});

test("the documented command is wired in package.json with the resolve hook", () => {
  // The removal script imports no src/lib module today, but the documented
  // invocation has to be the one that survives that changing — this is the bug
  // #177 was filed for, and the gate must not inherit it.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["orders:kv:remove"], /--import \.\/scripts\/register\.mjs/);
  assert.equal(KV_BINDING, "ORDERS");
});

test("the existence probe calls the real wrangler subcommand shape", () => {
  // wrangler 4.141 rejects `--json` on `kv namespace list` ("Unknown
  // argument"), so the probe must pass no flags and read the JSON array the
  // command always logs.
  const calls = [];
  const ids = defaultListNamespaceIds((cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: JSON.stringify([{ id: PROD_ID }, { id: PREVIEW_ID }]), stderr: "" };
  });
  assert.deepEqual(ids, [PROD_ID, PREVIEW_ID]);
  assert.deepEqual(calls[0], ["npx", "wrangler", "kv", "namespace", "list"]);
  assert.ok(!calls[0].includes("--json"), "wrangler rejects --json here");

  // A probe whose output shape we do not recognise must read as unknown, never
  // as an empty account: an empty result strips the binding.
  for (const stdout of ['{"result":[]}', '[{"title":"ORDERS"}]', "not json"]) {
    assert.throws(() => defaultListNamespaceIds(() => ({ status: 0, stdout, stderr: "" })), /parse|array|id/);
  }
  assert.deepEqual(defaultListNamespaceIds(() => ({ status: 0, stdout: "[]", stderr: "" })), []);
});

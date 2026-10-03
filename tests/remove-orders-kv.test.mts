import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  KV_BINDING,
  parseCount,
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

const keys = (n) => Array.from({ length: n }, (_, i) => `cs_test_${i}`);

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

test("a parity mismatch refuses and deletes nothing", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove([], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listKvKeys: () => keys(5),
    countD1Orders: () => 4,
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /parity check failed: D1 has 4 orders but KV ORDERS holds 5 keys/);
  assert.match(result.stdout, /"d1Orders":4,"kvKeys":5/);
  assert.deepEqual(deletes, []);
  assert.deepEqual(writes, []);
});

test("parity without --yes refuses and deletes nothing", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove([], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listKvKeys: () => keys(5),
    countD1Orders: () => 5,
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--yes was not passed/);
  assert.deepEqual(deletes, []);
  assert.deepEqual(writes, []);
});

test("parity with --yes deletes both namespaces then rewrites wrangler.toml", () => {
  const deletes = [];
  const writes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listKvKeys: () => keys(5),
    countD1Orders: () => 5,
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(deletes, [
    "c6f34450a61c4c69b3f840e845a7b0d3",
    "849af920ace64914904b2799bd0fc073",
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "wrangler.toml");
  assert.equal(parseOrdersKvBinding(writes[0][1]), null);
  assert.equal(result.bindingRemoved, true);
});

test("an unknown D1 count is a failed gate, not parity", () => {
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listKvKeys: () => keys(0),
    countD1Orders: () => null,
    deleteNamespace: (_spawn, id) => deletes.push(id),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /refusing to delete on an unknown count/);
  assert.deepEqual(deletes, []);
});

test("a failed namespace delete leaves wrangler.toml alone", () => {
  const writes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML,
    writeFileSync: (p, data) => writes.push([p, data]),
    listKvKeys: () => keys(5),
    countD1Orders: () => 5,
    deleteNamespace: (_spawn, id) => {
      if (id.startsWith("849")) throw new Error("delete failed for " + id);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wrangler.toml was NOT rewritten/);
  assert.deepEqual(writes, []);
});

test("an absent binding is refused instead of reported as already done", () => {
  const deletes = [];
  const result = runRemove(["--yes"], {
    readFileSync: () => TOML.replace('binding = "ORDERS"', 'binding = "OTHER"'),
    writeFileSync: () => assert.fail("must not rewrite the config"),
    listKvKeys: () => keys(5),
    countD1Orders: () => 5,
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
import assert from "node:assert/strict";
import test from "node:test";
import {
  isMastersBucket,
  isOrdersKv,
  readWorkerBindings,
} from "../src/lib/worker-bindings.ts";

const get = async () => null;
const put = async () => {};

test("ORDERS needs both get and put, MASTERS only get", () => {
  assert.equal(isOrdersKv({ get, put }), true);
  assert.equal(isOrdersKv({ get }), false, "get-only KV would throw on first write");
  assert.equal(isOrdersKv({ put }), false);
  assert.equal(isMastersBucket({ get }), true);
  assert.equal(isMastersBucket({ put }), false);
});

test("binding guards reject non-objects and wrong-typed members", () => {
  for (const bad of [null, undefined, 0, "", "ORDERS", true, Symbol("kv"), [get, put]]) {
    assert.equal(isOrdersKv(bad), false, String(bad));
    assert.equal(isMastersBucket(bad), false, String(bad));
  }
  for (const bad of [{ get: "get", put }, { get: {}, put }, { get, put: null }]) {
    assert.equal(isOrdersKv(bad), false, JSON.stringify(Object.keys(bad)));
  }
  assert.equal(isMastersBucket({ get: "get" }), false);
});

test("guards read the shape, never call the methods", () => {
  let calls = 0;
  const spy = async () => {
    calls++;
    return null;
  };
  assert.equal(isOrdersKv({ get: spy, put: spy }), true);
  assert.equal(isMastersBucket({ get: spy }), true);
  assert.equal(calls, 0);
});

test("readWorkerBindings never returns a binding that fails its own guard", async () => {
  const bindings = await readWorkerBindings();
  if (bindings.ORDERS !== undefined) assert.equal(isOrdersKv(bindings.ORDERS), true);
  if (bindings.MASTERS !== undefined) assert.equal(isMastersBucket(bindings.MASTERS), true);
  // No local Cloudflare context: KV bindings must be absent, never faked.
  assert.equal(bindings.ORDERS, undefined);
  assert.equal(bindings.MASTERS, undefined);
});

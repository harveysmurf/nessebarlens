import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../src/domain/json/record.ts";

test("isRecord accepts the objects a JSON body or KV value can carry", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  // A null-prototype object is what `Object.create(null)` and some structured
  // clone paths produce; it is still a map we can read keys off.
  assert.equal(isRecord(Object.create(null)), true);
  // Nested values stay unknown -- the guard claims the top level only.
  const nested = { order: { id: "x" } };
  assert.equal(isRecord(nested), true);
  assert.equal((nested as Record<string, unknown>).order instanceof Object, true);
});

test("isRecord refuses the arrays the two-line check let through", () => {
  // `typeof [] === "object"` and `[] !== null`, so the check this replaces
  // accepted an array and then read `undefined` off it.
  assert.equal(isRecord([]), false, "empty array");
  assert.equal(isRecord([{ id: "x" }]), false, "array of objects");
  assert.equal(isRecord(new Array(3)), false, "sparse array");
});

test("isRecord refuses every primitive, including the falsy ones", () => {
  for (const value of [undefined, null, 0, -0, NaN, "", "str", true, false]) {
    assert.equal(isRecord(value), false, String(value));
  }
});

/** The caller shape this guard exists for: unknown in, one named key out. */
function readId(value: unknown): unknown {
  return isRecord(value) ? value.id : undefined;
}

test("a Date or Map passes as a map and reads as an empty one", () => {
  // Not a bug: the strictest of the two guards this replaces (`isMapping`)
  // accepted these too, and nothing that reaches this guard reads prototype
  // keys off the result -- every caller reads a named own key and falls back
  // when it is `undefined`, which is exactly what a Date does. Asserted so a
  // future "make it a plain-object check" change is a deliberate one.
  for (const value of [new Date(0), new Map(), new Set(), /x/]) {
    assert.equal(isRecord(value), true, String(value));
    assert.equal(readId(value), undefined, String(value));
  }
});

test("isRecord is what JSON.parse produces for each JSON top-level value", () => {
  // The five top-level values JSON allows, as the callers actually see them:
  // everything reaches this guard from a body or a stored value.
  for (const [raw, expected] of [
    ["null", false],
    ["[]", false],
    ['"str"', false],
    ["42", false],
    ["true", false],
    ['{"a":1}', true],
  ] as const) {
    assert.equal(isRecord(JSON.parse(raw)), expected, raw);
  }
});
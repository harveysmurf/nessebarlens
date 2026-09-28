import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256Hex, timingSafeEqualHex } from "../src/lib/crypto-hex.ts";

test("hmacSha256Hex is stable and hex-encoded", async () => {
  const a = await hmacSha256Hex("hello", "secret");
  const b = await hmacSha256Hex("hello", "secret");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, await hmacSha256Hex("hello", "other"));
});

test("timingSafeEqualHex is case-insensitive and length-safe", () => {
  assert.equal(timingSafeEqualHex("abcd", "ABCD"), true);
  assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  assert.equal(timingSafeEqualHex("abcd", "abc"), false);
  assert.equal(timingSafeEqualHex("", ""), true);
});

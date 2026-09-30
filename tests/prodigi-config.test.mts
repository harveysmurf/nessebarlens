import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PRODIGI_LIVE_API_BASE,
  PRODIGI_SANDBOX_API_BASE,
  isProdigiUnconfigured,
  prodigiApiBase,
  prodigiApiKey,
  prodigiErrorStatus,
  prodigiFailure,
  prodigiKeyConfigured,
} from "../src/lib/prodigi-config.ts";

/**
 * Every message this module can actually produce, by calling the function
 * that throws it with the env that provokes it. Enumerating them by hand was
 * the thing that rotted: a fourth throw site could be added and nothing would
 * notice it was unclassified, so an unset secret would report itself as 502 —
 * "Prodigi is down" — when it means "this deploy is misconfigured".
 */
function throwableMessages(): string[] {
  const messages: string[] = [];

  for (const env of [
    {}, // unset
    { PRODIGI_API_BASE: "https://api.example.com" }, // not an allowed host
    { PRODIGI_API_BASE: " " }, // blank
    { PRODIGI_API_BASE: 42 }, // wrong type
  ]) {
    try {
      prodigiApiBase(env);
      assert.fail(`prodigiApiBase should throw for ${JSON.stringify(env)}`);
    } catch (error) {
      messages.push((error as Error).message);
    }
  }

  for (const env of [
    { PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE },
    { PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE },
  ]) {
    try {
      prodigiApiKey(env);
      assert.fail(`prodigiApiKey should throw for ${JSON.stringify(env)}`);
    } catch (error) {
      messages.push((error as Error).message);
    }
  }

  return messages;
}

test("every message this module can throw is classified as unconfigured", () => {
  const messages = throwableMessages();
  assert.equal(messages.length, 6, "the throw-site inventory changed");
  for (const message of messages) {
    assert.equal(
      isProdigiUnconfigured(message),
      true,
      `unclassified: ${message}`,
    );
    assert.equal(prodigiErrorStatus(message), 503, `wrong status: ${message}`);
  }
});

test("this module has no throw site the inventory test does not reach", () => {
  // The enumeration above calls the two functions that throw. If a third
  // function starts throwing, that message would be served as 502 and this is
  // what says so -- an inventory that only covers the sites it knows about
  // would otherwise quietly stop being complete.
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/lib/prodigi-config.ts"),
    "utf8",
  );
  const throwers = new Set<string>();
  for (const match of source.matchAll(
    /export function (\w+)[\s\S]*?^}/gm,
  )) {
    if (match[0]!.includes("throw new Error")) throwers.add(match[1]!);
  }
  assert.deepEqual([...throwers].sort(), ["prodigiApiBase", "prodigiApiKey"]);
});

test("a real Prodigi failure is 502, not our misconfiguration", () => {
  for (const message of [
    "Prodigi returned 500",
    "The API key you provided is not set", // similar words, not our message
    "PRODIGI_API_KEY is unset", // near miss
    "PRODIGI_API_BASE must be something else entirely",
    "",
  ]) {
    assert.equal(isProdigiUnconfigured(message), false, message);
    assert.equal(prodigiErrorStatus(message), 502, message);
  }
});

test("prodigiErrorStatus is the one place the 503/502 split is decided", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/lib/prodigi-config.ts"),
    "utf8",
  );
  for (const route of ["quote", "checkout"]) {
    const routeSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", `src/app/api/${route}/route.ts`),
      "utf8",
    );
    // Asserted on the call name only, never on the argument spelling: a route
    // that renames its catch binding must not break a guard about classification.
    assert.ok(
      routeSource.includes("prodigiFailure("),
      `${route} must take its Prodigi status from prodigi-config`,
    );
    assert.equal(
      /e instanceof Error \? e\.message :/.test(routeSource),
      false,
      `${route} re-derives the Prodigi error message`,
    );
    assert.equal(
      /isProdigiUnconfigured\([^)]*\)\s*\?\s*503\s*:\s*502/.test(routeSource),
      false,
      `${route} re-decides the 503/502 split`,
    );
  }
  assert.match(source, /export function prodigiErrorStatus/);
});

test("a configured key is reported as configured on both hosts", () => {
  assert.equal(prodigiKeyConfigured({}), false);
  assert.equal(
    prodigiKeyConfigured({ PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE }),
    false,
  );
  assert.equal(
    prodigiKeyConfigured({
      PRODIGI_API_BASE: PRODIGI_SANDBOX_API_BASE,
      PRODIGI_SANDBOX_API_KEY: "k",
    }),
    true,
  );
  // A live base with only the sandbox key is not configured — the key and the
  // host have to be a matched pair, which is why the key name is chosen from
  // the base rather than sniffed.
  assert.equal(
    prodigiKeyConfigured({
      PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE,
      PRODIGI_SANDBOX_API_KEY: "k",
    }),
    false,
  );
  assert.equal(
    prodigiKeyConfigured({
      PRODIGI_API_BASE: PRODIGI_LIVE_API_BASE,
      PRODIGI_API_KEY: "k",
    }),
    true,
  );
});

test("prodigiFailure unwraps the message and classifies it in one step", () => {
  assert.deepEqual(
    prodigiFailure(new Error("Prodigi is not set")),
    { error: "Prodigi is not set", status: 502 },
  );
  // A misconfigured deploy must keep reporting 503, not slip to 502 now that
  // the message is unwrapped in a different place.
  assert.deepEqual(
    prodigiFailure(new Error("PRODIGI_API_KEY is not set")),
    { error: "PRODIGI_API_KEY is not set", status: 503 },
  );
  assert.equal(
    prodigiFailure(new Error("PRODIGI_SANDBOX_API_KEY is not set")).status,
    503,
  );
});

test("prodigiFailure falls back to the one message for a non-Error throw", () => {
  assert.deepEqual(prodigiFailure("just a string"), {
    error: "Quote failed",
    status: 502,
  });
  assert.deepEqual(prodigiFailure(undefined), {
    error: "Quote failed",
    status: 502,
  });
});

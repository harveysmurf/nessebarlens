import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { checkoutUrl, errorMessage } from "../src/lib/api-payloads.ts";

const CONFIGURATOR = fs.readFileSync(
  new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
  "utf8",
);

test("a non-ok response surfaces the server's own error string", () => {
  // The order in the component matters: `checkoutUrl` rejects a non-https url,
  // and the buyer must still see what the server said rather than a generic
  // message. This is the shape both orderings agree on, pinned so the
  // invariant is expressed at the helper level too.
  const data = { url: "http://evil.example/pay", error: "Stripe unavailable" };
  assert.equal(checkoutUrl(data), null);
  assert.equal(errorMessage(data), "Stripe unavailable");
});

test("the transport status is checked before the redirect url is resolved", () => {
  // Hoisted above `checkoutUrl` so a non-ok response reports the server's
  // error regardless of what the payload's `url` looks like.
  const okIndex = CONFIGURATOR.indexOf("if (!res.ok) {");
  const urlIndex = CONFIGURATOR.indexOf("const url = checkoutUrl(data);");
  assert.ok(okIndex > -1, "the !res.ok branch should still exist");
  assert.ok(urlIndex > -1, "checkoutUrl should still be called");
  assert.ok(
    okIndex < urlIndex,
    "the !res.ok check must come before checkoutUrl is called",
  );
  assert.match(CONFIGURATOR, /if \(!res\.ok\) \{\s*\n\s*throw new Error\(errorMessage\(data\)/);
});

test("the redirect sink is only reached through checkoutUrl", () => {
  const assignments = CONFIGURATOR.match(/window\.location\.[a-z]+\s*=/g) ?? [];
  assert.deepEqual(assignments, ["window.location.href ="]);
  assert.match(CONFIGURATOR, /window\.location\.href = url;/);
});

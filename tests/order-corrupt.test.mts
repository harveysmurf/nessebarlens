import assert from "node:assert/strict";
import test from "node:test";

import { masterKeyForSlug } from "../src/lib/master-key.ts";
import { parseOrderRecord } from "../src/lib/order-decision.ts";
import {
  describeCorruptOrder,
  readOrderRecord,
  reportCorruptOrder,
} from "../src/lib/order-corrupt.ts";

const SESSION = "cs_test_abcdefgh";
// parseOrderRecord holds a paid digital order to the catalog's own master key,
// so the happy-path fixture has to carry the real one for "dawn" rather than
// any placeholder — otherwise the fixture is rejected and every silence
// assertion below would pass for the wrong reason.
const MASTER_KEY = masterKeyForSlug("dawn") ?? "";

/** Capture every console.error line `body` emits, parsed. */
async function captureErrors(
  body: () => Promise<void> | void,
): Promise<Array<Record<string, unknown>>> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A record the parser accepts, so a test can prove silence on the happy path. */
function validRecord(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: "dawn",
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: MASTER_KEY,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

test("a rejected record logs order.corrupt with the session id and the path", async () => {
  const events = await captureErrors(() => {
    assert.equal(readOrderRecord("{not json", SESSION, "download"), null);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "order.corrupt");
  assert.equal(events[0]!.sessionId, SESSION);
  assert.equal(events[0]!.path, "download");
  assert.equal(events[0]!.json, false);
});

test("each read path names itself, so the log says where to look", async () => {
  for (const path of [
    "download",
    "order-status",
    "page",
    "revoke",
    "webhook",
  ] as const) {
    const events = await captureErrors(() => {
      readOrderRecord("{}", SESSION, path);
    });
    assert.equal(events.length, 1, path);
    assert.equal(events[0]!.path, path);
  }
});

test("a record that parses and names its own key is returned silently", async () => {
  // The regression this whole issue is about is the opposite direction: a log
  // here would be noise on every ordinary read, and noise is what gets the
  // alert muted.
  const events = await captureErrors(() => {
    const order = readOrderRecord(validRecord(), SESSION, "download");
    assert.notEqual(order, null);
    assert.equal(order!.sessionId, SESSION);
  });
  assert.deepEqual(events, []);
});

test("a record filed under a key it does not name is corrupt, not a hit", async () => {
  // The parser accepts this -- merchantReference matches its own sessionId --
  // so only the caller's key check catches it. Folding that check in is why all
  // three read paths can share one failure shape.
  const other = "cs_test_zzzzzzzz";
  const filed = validRecord({ sessionId: other, merchantReference: other });
  assert.notEqual(
    parseOrderRecord(filed),
    null,
    "the record is valid under the key it names",
  );
  const events = await captureErrors(() => {
    assert.equal(readOrderRecord(filed, SESSION, "download"), null);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.keyMatches, false);
});

test("the log never carries the record's contents", async () => {
  // A stored record holds a name, an address, a master key and an asset URL.
  // None of it may reach a log line; an operator reads the bytes out of KV with
  // the access that record deserves, not through an observability tool.
  const secret = {
    // A revoked digital order must have masterKey null, so these values make
    // the record genuinely unreadable -- which is the situation being logged.
    status: "refunded",
    name: "Ada Lovelace",
    masterKey: "masters/dawn/full.tif",
    assetUrl: "https://example.test/api/print-asset?sig=deadbeef",
    email: "ada@example.test",
  };
  const raw = validRecord(secret);
  assert.equal(
    parseOrderRecord(raw),
    null,
    "the record must really be rejected",
  );
  const events = await captureErrors(() => {
    readOrderRecord(raw, SESSION, "page");
  });
  assert.equal(events.length, 1);
  const line = JSON.stringify(events[0]);
  for (const value of Object.values(secret)) {
    assert.equal(line.includes(value), false, `${value} leaked into the log`);
  }
  // The discriminators an operator acts on are present.
  assert.equal(events[0]!.bytes, raw.length);
  assert.equal(events[0]!.json, true);
  assert.equal(events[0]!.version, 1);
});

test("an empty value is told apart from a truncated one", async () => {
  // Both are "cannot parse", but only one of them is a write that never
  // completed, and the byte count is the whole difference.
  const empty = describeCorruptOrder("", SESSION);
  const truncated = describeCorruptOrder('{"v":1,"sessionId":"cs_tes', SESSION);
  assert.equal(empty.bytes, 0);
  assert.ok(truncated.bytes > 0);
  assert.equal(truncated.json, false);
  assert.equal(truncated.version, null, "an unparsable value has no version");
});

test("a newer schema version is reported, which is the usual cause", async () => {
  // The most common real corruption is a writer on a shape this reader does not
  // know. Reporting the version lets an operator tell that apart from junk.
  const facts = describeCorruptOrder(validRecord({ v: 2 }), SESSION);
  assert.equal(facts.version, 2);
  assert.equal(facts.json, true);
});

test("reportCorruptOrder emits the same shape as the automatic path", async () => {
  // Two emitters would be two alert formats. The refund path had its own
  // console.error before; it now shares this one.
  const auto = await captureErrors(() => {
    readOrderRecord("nope", SESSION, "download");
  });
  const manual = await captureErrors(() => {
    reportCorruptOrder(
      SESSION,
      "revoke",
      describeCorruptOrder("nope", SESSION),
    );
  });
  assert.deepEqual(
    Object.keys(manual[0]!).sort(),
    Object.keys(auto[0]!).sort(),
  );
  assert.deepEqual(manual[0]!.event, "order.corrupt");
  assert.equal(manual[0]!.path, "revoke");
});

test("the read paths call one helper, not three copies of the check", async () => {
  // The acceptance criterion that a behavioural test cannot see: a per-route
  // console.error would satisfy "a log is emitted" three times over and drift
  // three ways. Assert the shape of the call sites instead.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(import.meta.dirname, "..");
  const callers = [
    "src/app/api/download/route.ts",
    "src/app/api/order-status/route.ts",
    "src/app/checkout/success/order-state.ts",
    "src/lib/fulfillment.ts",
    "src/lib/order-revocation.ts",
  ];
  for (const rel of callers) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(src, /from "[.@][^"]*order-corrupt"/, rel);
    // The sessionId check belongs to the helper now, so a read path that kept
    // it would be checking twice and implying the helper does not.
    assert.equal(
      /order\.sessionId !== sessionId/.test(src),
      false,
      `${rel} duplicates the key check that readOrderRecord owns`,
    );
  }
  // And the log itself is spelled once in src/.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf8");
        if (src.includes('"order.corrupt"')) {
          offenders.push(path.relative(root, full));
        }
      }
    }
  };
  walk(path.join(root, "src"));
  assert.deepEqual(offenders, ["src/lib/order-corrupt.ts"]);
});

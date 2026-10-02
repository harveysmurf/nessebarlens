import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devOrdersSeed, seededOrdersKv } from "../src/lib/orders-dev-seed.ts";
import { parseOrderRecord, orderViewState } from "../src/lib/order-decision.ts";
import { isCheckoutSessionId } from "../src/lib/order-decision.ts";
import { isProduction } from "../src/lib/config.ts";

/* The dev ORDERS seed (#143).

   The E2E success-page states are only reachable on a bare dev server through
   this module, so its two guards are the load-bearing part: a seed that ran in
   production would serve a fabricated "your download is ready" to a paying
   customer, and a seed that silently did nothing would let the browser spec
   pass on the one state it had anyway. Both failure modes are tested here. */

const SEED_PATH = "e2e/fixtures/orders-seed.json";

const SEED = { ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "test" };
const PRODUCTION = { ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "production" };

test("no flag means no seed, so every other dev and test run is untouched", () => {
  assert.equal(devOrdersSeed({}), undefined);
  assert.equal(devOrdersSeed({ NODE_ENV: "test" }), undefined);
  // Blank is the same as unset: envString trims and drops empties, so a stray
  // `ORDERS_DEV_SEED=` in a shell profile cannot turn seeding on.
  assert.equal(devOrdersSeed({ ORDERS_DEV_SEED: "   " }), undefined);
});

test("the seed refuses to run under NODE_ENV=production", () => {
  // A throw, not undefined. Undefined would degrade to "processing" and pass
  // the very specs the seed exists to give real states to.
  assert.throws(() => devOrdersSeed(PRODUCTION), /refusing to use ORDERS_DEV_SEED/);

  // The same rule every other reader follows (envString trims), and the one
  // place it must not be skipped is a guard in front of fabricated orders.
  assert.equal(isProduction({ NODE_ENV: "production " }), true);
  assert.throws(
    () => devOrdersSeed({ ORDERS_DEV_SEED: SEED_PATH, NODE_ENV: "production " }),
    /refusing to use ORDERS_DEV_SEED/,
  );
});

test("readWorkerBindings returns the seed only when there is no real binding", async () => {
  // The wiring itself, not just the seed module: the E2E states are reachable
  // only if this is true, and a refactor that drops the call would leave the
  // browser specs passing on "processing" alone.
  const { readWorkerBindings } = await import("../src/lib/worker-bindings.ts");
  const readEnv = async () => ({});

  assert.equal((await readWorkerBindings({ readEnv })).ORDERS, undefined);

  const seeded = await readWorkerBindings({ readEnv: async () => ({ ...SEED }) });
  assert.notEqual(seeded.ORDERS, undefined);
  // The MASTERS bucket is never seeded — only ORDERS has a fixture, and a
  // fabricated master bucket would make /api/download serve something.
  assert.equal(seeded.MASTERS, undefined);

  // The seed wins over a binding, because `next dev` mounts a real but empty
  // local KV proxy for ORDERS (initOpenNextCloudflareForDev) — a
  // real-binding-beats-seed rule would leave the browser specs rendering
  // "processing" on every dev server, which is exactly what the seed exists to
  // fix. Setting the flag is the opt-in; the production refusal above is what
  // keeps it away from a deployed namespace.
  const real = { get: async () => null, put: async () => {} };
  const withReal = await readWorkerBindings({
    readEnv: async () => ({ ORDERS: real, ...SEED }),
  });
  assert.notEqual(withReal.ORDERS, real);
  assert.equal(
    await withReal.ORDERS?.get("cs_test_e2edigitalpaid00000001"),
    await seededOrdersKv(SEED_PATH).get("cs_test_e2edigitalpaid00000001"),
  );

  // No flag, a real binding is used as-is.
  const unseeded = await readWorkerBindings({
    readEnv: async () => ({ ORDERS: real, NODE_ENV: "test" }),
  });
  assert.equal(unseeded.ORDERS, real);
});

test("readWorkerBindings propagates the production refusal rather than swallowing it", async () => {
  // readWorkerBindings catches a *throwing env reader* and carries on with no
  // binding. That catch must not also swallow a refusal, or production would
  // quietly render "processing" instead of failing the deploy loudly.
  const { readWorkerBindings } = await import("../src/lib/worker-bindings.ts");
  await assert.rejects(
    () => readWorkerBindings({ readEnv: async () => ({ ...PRODUCTION }) }),
    /refusing to use ORDERS_DEV_SEED/,
  );
});

test("a missing or malformed seed file fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "orders-seed-"));
  const nested = join(dir, "nested.json");
  writeFileSync(nested, JSON.stringify({ cs_test_a: { v: 1 } }));
  const list = join(dir, "list.json");
  writeFileSync(list, JSON.stringify([{ v: 1 }]));

  assert.throws(() => seededOrdersKv(join(dir, "absent.json")), /cannot read seed file/);
  assert.throws(() => seededOrdersKv(nested), /must be a JSON \*string\*/);
  assert.throws(() => seededOrdersKv(list), /must be a JSON object/);
});

test("the KV shape passes the same guard a real binding must pass", async () => {
  // isOrdersKv requires get *and* put — a get-only fake would satisfy a looser
  // mock and then throw on the first webhook write. Asserted here against the
  // real predicate rather than by using it, so the two cannot drift.
  const { isOrdersKv } = await import("../src/lib/worker-bindings.ts");
  const kv = seededOrdersKv(SEED_PATH);
  assert.equal(isOrdersKv(kv), true);
});

test("the seed is in-memory: a put is visible to get, and nothing persists", async () => {
  const kv = seededOrdersKv(SEED_PATH);
  assert.equal(await kv.get("cs_test_written_here_0000000099"), null);
  await kv.put("cs_test_written_here_0000000099", "written");
  assert.equal(await kv.get("cs_test_written_here_0000000099"), "written");

  // A second KV over the same file does not see it — that is what keeps a stale
  // fixture from standing in for a fresh checkout within one dev server.
  assert.equal(await seededOrdersKv(SEED_PATH).get("cs_test_written_here_0000000099"), null);
});

test("every seeded record parses and yields the state its fixture claims", async () => {
  // The point of hand-written fixtures: they are only worth anything if they
  // are real stored records. If the stored shape moves and these do not, the
  // browser specs would render "could not read this order" and fail — but this
  // test fails first and names the shape.
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  assert.ok(Object.keys(raw).length >= 3, "expected at least three seeded states");

  // Token keys live in the same namespace (#111) and are not order records, so
  // they are checked below rather than fed to the order parser.
  const tokenKeys = Object.keys(raw).filter((key) => key.startsWith("d"));
  const orderKeys = Object.keys(raw).filter((key) => !key.startsWith("d"));
  assert.deepEqual(
    [...tokenKeys].sort((a, b) => a.localeCompare(b)),
    ["dl:e2ef17e0000000000000000000000aa0", "dls:cs_test_e2edigitalpaid00000001"],
    "the seeded download tokens changed; update this and the e2e spec's href",
  );

  const states = new Map<string, string>();
  for (const sessionId of orderKeys) {
    const value = raw[sessionId]!;
    // isCheckoutSessionId is checked first by the page itself: a malformed id
    // would render invalid-session and never reach ORDERS, so the fixture would
    // pass a browser test while proving nothing about order states.
    assert.equal(isCheckoutSessionId(sessionId), true, sessionId);

    const order = parseOrderRecord(value);
    assert.ok(order, `seed record does not parse: ${sessionId}`);
    assert.equal(order.sessionId, sessionId, "record must name the key it is filed under");
    states.set(sessionId, orderViewState(order));
  }

  // The three states #143 names, each actually present. Pinned by name so
  // renaming a fixture id cannot quietly drop one state from the suite.
  assert.deepEqual(
    [...states.values()].sort(),
    ["digital-pending", "digital-ready", "physical"],
  );
});

test("the paid digital fixture carries a master key the catalog actually has", async () => {
  // order-decision re-derives the expected masterKey from the catalog and
  // rejects a record whose key does not match, so a fixture pointing at a
  // renamed or deleted photo stops parsing here rather than in the browser.
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  const { masterKeyForSlug } = await import("../src/lib/master-key.ts");
  for (const [sessionId, value] of Object.entries(raw)) {
    if (sessionId.startsWith("d")) continue;
    const order = parseOrderRecord(value);
    assert.ok(order, sessionId);
    if (order.format === "digital" && order.status === "paid") {
      assert.equal(order.masterKey, masterKeyForSlug(order.photoSlug));
      assert.notEqual(order.masterKey, null, `${order.photoSlug} is not in the catalog`);
    }
  }
});
test("the seeded token is the one the paid digital order resolves to (#111)", async () => {
  // The success page now renders `digital-no-token` when no token exists, so a
  // seed without one would make the browser spec pass on the wrong branch. This
  // runs the page's own resolver against the real seed file.
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;
  const { downloadLinkForSession } = await import("../src/lib/download-token.ts");
  const { parseDownloadTokenRecord } = await import("../src/lib/download-token.ts");
  const kv = seededOrdersKv(SEED_PATH);
  const paid = "cs_test_e2edigitalpaid00000001";

  assert.equal(await kv.get(paid), raw[paid], "the seed is read as-is");
  assert.equal(await downloadLinkForSession(kv, "cs_test_e2ephysicalawaitingprodigi03"), null);
  assert.equal(await downloadLinkForSession(kv, "cs_test_e2edigitalpending000002"), null);

  const link = await downloadLinkForSession(kv, paid);
  assert.equal(link, "/api/download?token=e2ef17e0000000000000000000000aa0");

  // And the `dl:<token>` side parses as a token record, not an order record.
  assert.ok(parseDownloadTokenRecord((await kv.get("dl:e2ef17e0000000000000000000000aa0"))!));
});

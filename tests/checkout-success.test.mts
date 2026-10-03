import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

/* The checkout success page's decision, and the endpoint that feeds it (#103).

   The page used to render one thing for every order — a "Go to download" link —
   so a physical buyer got a link that 403s `not-a-digital-download`, and a
   digital buyer who arrived before the webhook saw a raw `{"status":
   "processing"}` JSON body. Both are the same defect: the page was not reading
   the order.

   resolveCheckoutPageState is the single place that now reads it. It is tested
   here as the unit it is, with readWorkerBindings substituted the same way
   routes.test.mts does, because ORDERS_DB is a Worker binding with no env
   fallback and these states are otherwise unreachable from a test. */

const FAKE = "buzz-test:checkout-page-bindings";

type Fake = { ORDERS_DB?: unknown; MASTERS?: unknown };

const globals = globalThis as { __buzzBindings?: Fake };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/worker-bindings") {
      return { url: FAKE, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === FAKE) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export async function readWorkerBindings() { return globalThis.__buzzBindings; }",
      };
    }
    return nextLoad(url, context);
  },
});

const { resolveCheckoutPageState, resolveCheckoutDownloadLink } = await import(
  "../src/app/checkout/success/order-state.ts"
);
const { ensureDownloadToken } = await import("../src/lib/download-token.ts");
const { orderViewState } = await import("../src/lib/order-decision.ts");
const { memoryOrdersStore } = await import("./fake-orders-store.mts");
type OrderRecord = import("../src/lib/order-decision.ts").OrderRecord;
const orderStatus = await import("../src/app/api/order-status/route.ts");

const SESSION = "cs_test_abcdefgh";
// Must match the configured site origin because that is how records are
// generated — the read path no longer compares origins (#110), so a fixture on
// another host would stop proving anything about the real write path.
const SITE = "https://nessebarlens.com";
process.env.NEXT_PUBLIC_SITE_URL = SITE;
/** The real master key for the "dawn" photo; a paid digital record must match it exactly. */
const MASTER_KEY = "prints/dawn.jpg";
const ASSET_URL = `${SITE}/api/print-asset?slug=dawn&expires=1799999999&sig=x`;
const RECIPIENT = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

/** An in-memory OrdersStore seeded with raw order JSON keyed by session id. */
const memoryStore = (orders: Record<string, string> = {}) =>
  memoryOrdersStore({ orders });

const DEFAULTS = {
  v: 1,
  sessionId: SESSION,
  merchantReference: SESSION,
  terminal: true,
  status: "paid",
  photoSlug: "dawn",
  format: "digital",
  size: "50x70",
  frame: "",
  quoteEur: 12,
  amountTotal: 1200,
  currency: "eur",
  reason: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
} as const;

/**
 * A record parseOrderRecord will actually accept.
 *
 * The overrides are not arbitrary: a paid *digital* record must name exactly the
 * master key its slug resolves to, and a paid *physical* one must carry a Prodigi
 * order id, an asset url and a recipient. Fixtures that skip those are rejected as
 * corrupt, which would make these tests pass for the wrong reason — every one of
 * them would read "unavailable" instead of the state under test.
 */
function record(over: Record<string, unknown> = {}) {
  const merged = { ...DEFAULTS, ...over };
  const physical = merged.format !== "digital";
  // Revoking is defined as dropping the file: a revoked record must name no
  // master key at all. Left to the defaults, a `status: "refunded"` override
  // would still carry one and parse as corrupt rather than revoked — which would
  // have made the revoked assertions pass for the wrong reason.
  const revoked = merged.status === "refunded" || merged.status === "disputed";
  // Only a *paid digital* record names a master key. A print never does, and
  // neither does a revoked or an unfulfilled order — parseOrderRecord rejects
  // all of those otherwise, which would make these assertions read
  // "unavailable" and pass for the wrong reason.
  const namesFile = !physical && merged.status === "paid" && !revoked;
  const namedMaster = over.masterKey ?? (namesFile ? MASTER_KEY : null);
  return JSON.stringify({
    ...merged,
    masterKey: namedMaster,
    recipient: over.recipient ?? (physical ? RECIPIENT : null),
    prodigiOrderId: over.prodigiOrderId ?? (physical ? "ord_abc" : null),
    prodigiStage: over.prodigiStage ?? (physical ? "awaiting_payment" : null),
    assetUrl: over.assetUrl ?? (physical ? ASSET_URL : null),
  });
}

/**
 * A KV holding a paid digital order *and* its download token (#111).
 *
 * Both halves are required for the page to render a link: the order record says
 * the file is ready, and the token is the only thing that now grants it. A KV
 * with just the record resolves to "digital-no-token", which is its own branch.
 */
async function downloadableStore(over: Record<string, unknown> = {}) {
  const store = memoryStore({ [SESSION]: record(over) });
  await ensureDownloadToken({
    store,
    sessionId: SESSION,
    limits: { ttlSeconds: 30 * 86_400, maxDownloads: 5 },
  });
  return store;
}

async function withBindings<T>(next: Fake, run: () => Promise<T>): Promise<T> {
  const previous = globals.__buzzBindings;
  globals.__buzzBindings = next;
  try {
    return await run();
  } finally {
    globals.__buzzBindings = previous;
  }
}

// ---- orderViewState: the closed set the page and the route share. ----

test("a physical order is physical, whatever its status", async () => {
  const { parseOrderRecord } = await import("../src/lib/order-decision.ts");
  // Checked for every status, because the page showed a download link to these
  // buyers and a status-dependent answer here would put it back for some of them.
  for (const status of ["paid", "paid-unfulfilled", "refunded", "disputed"]) {
    const order = parseOrderRecord(record({ format: "giclee", status }))!;
    assert.equal(orderViewState(order), "physical", `status ${status}`);
  }
});

test("orderViewState maps each digital status to its own case", () => {
  // Driven straight off an OrderRecord rather than through parseOrderRecord:
  // orderViewState is a pure function over the record, and going through the
  // parser here would only re-test the parser. The shapes below are the ones
  // fulfillment actually writes — this asserts the mapping, not validity.
  const order = (over: Record<string, unknown>) =>
    ({
      v: 1,
      sessionId: SESSION,
      merchantReference: SESSION,
      terminal: true,
      status: "paid",
      photoSlug: "dawn",
      format: "digital",
      size: "50x70",
      frame: "",
      quoteEur: 12,
      amountTotal: 1200,
      currency: "eur",
      reason: null,
      masterKey: MASTER_KEY,
      recipient: null,
      prodigiOrderId: null,
      prodigiStage: null,
      assetUrl: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      ...over,
    }) as OrderRecord;

  assert.equal(orderViewState(order({})), "digital-ready");
  // Paid but no master key: nothing to serve, so not "ready" even though the
  // money is in. Terminal means fulfillment gave up, so it is not "pending".
  assert.equal(orderViewState(order({ masterKey: null })), "digital-unavailable");
  assert.equal(
    orderViewState(order({ status: "paid-unfulfilled", terminal: true })),
    "digital-unavailable",
  );
  // Not terminal is the retryable case: Stripe may redeliver, so keep waiting.
  assert.equal(
    orderViewState(order({ status: "paid-unfulfilled", terminal: false })),
    "digital-pending",
  );
  assert.equal(orderViewState(order({ status: "refunded", masterKey: null })), "revoked");
  assert.equal(orderViewState(order({ status: "disputed", masterKey: null })), "revoked");
});

// ---- resolveCheckoutPageState ----

test("a missing or malformed session_id never reaches the store", async () => {
  let touched = 0;
  // A full port, not a stub: worker-bindings drops a binding that fails the
  // shape guard, so a get/put-shaped fake would be discarded and this test
  // would pass without ever calling resolveCheckoutPageState's store path.
  const store = memoryStore();
  const counted = {
    ...store,
    async getOrder(sessionId: string) {
      touched++;
      return store.getOrder(sessionId);
    },
  };
  await withBindings({ ORDERS_DB: counted }, async () => {
    assert.equal(await resolveCheckoutPageState(undefined), "missing-session");
    assert.equal(await resolveCheckoutPageState(""), "missing-session");
    assert.equal(await resolveCheckoutPageState("not-a-session"), "invalid-session");
    assert.equal(await resolveCheckoutPageState("../../etc/passwd"), "invalid-session");
    assert.equal(touched, 0, "an unvalidated id must not reach the store");
  });
});

test("a digital order with a stored record and a token is ready", async () => {
  await withBindings({ ORDERS_DB: await downloadableStore() }, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "digital-ready");
  });
});

test("a paid order with no token is digital-no-token, and mints nothing (#111)", async () => {
  // The page holds the session id in its URL, so minting a token on demand here
  // would hand back exactly the bearer credential tokens replaced.
  const store = memoryStore({ [SESSION]: record() });
  await withBindings({ ORDERS_DB: store }, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "digital-no-token");
    assert.equal(
      await store.findDownloadToken(SESSION),
      null,
      "no token was written",
    );
    assert.equal(await resolveCheckoutDownloadLink(SESSION), null);
  });
});

test("the download link carries the stored token, not the session id", async () => {
  const store = await downloadableStore();
  await withBindings({ ORDERS_DB: store }, async () => {
    const link = await resolveCheckoutDownloadLink(SESSION);
    assert.match(link!, /^\/api\/download\?token=[0-9a-f]{32}$/);
    assert.doesNotMatch(link!, /session_id/);
    assert.equal(await resolveCheckoutDownloadLink(undefined), null);
    assert.equal(await resolveCheckoutDownloadLink("not-a-session"), null);
  });
});

test("a physical order never resolves to a downloadable state", async () => {
  await withBindings(
    { ORDERS_DB: memoryStore({ [SESSION]: record({ format: "canvas" }) }) },
    async () => {
      assert.equal(await resolveCheckoutPageState(SESSION), "physical");
    },
  );
});

test("no record yet is processing, not an error", async () => {
  // The ordinary first seconds after payment: Stripe has not called the webhook.
  await withBindings({ ORDERS_DB: memoryStore() }, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "processing");
  });
});

test("a degraded store degrades to processing rather than throwing", async () => {
  // The page must not 500 after Stripe took the money. A missing binding and a
  // throwing get() both render "we are preparing your download", which is a
  // claim we can actually make.
  await withBindings({}, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "processing");
  });
  await withBindings(
    {
      ORDERS_DB: {
        ...memoryStore(),
        async getOrder(): Promise<string | null> {
          throw new Error("store down");
        },
      },
    },
    async () => {
      assert.equal(await resolveCheckoutPageState(SESSION), "processing");
    },
  );
});

test("an unparseable or foreign record is unavailable, not pending", async () => {
  await withBindings({ ORDERS_DB: memoryStore({ [SESSION]: "not json" }) }, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "unavailable");
  });
  // A record stored under this key naming a different session is not this
  // buyer's order, whatever else it says.
  await withBindings(
    { ORDERS_DB: memoryStore({ [SESSION]: record({ sessionId: "cs_test_other" }) }) },
    async () => {
      assert.equal(await resolveCheckoutPageState(SESSION), "unavailable");
    },
  );
});

// ---- /api/order-status ----

test("order-status: an unvalidated session id is a 400 before the store", async () => {
  let touched = 0;
  // A full port, not a stub: worker-bindings drops a binding that fails the
  // shape guard, so a get/put-shaped fake would be discarded and this test
  // would pass without ever calling resolveCheckoutPageState's store path.
  const store = memoryStore();
  const counted = {
    ...store,
    async getOrder(sessionId: string) {
      touched++;
      return store.getOrder(sessionId);
    },
  };
  await withBindings({ ORDERS_DB: counted }, async () => {
    for (const url of [
      `${SITE}/api/order-status?session_id=nope`,
      // No param at all: the null side of the `?? ""` fallback, which a URL
      // built by hand or a link stripped of its query string can produce.
      `${SITE}/api/order-status`,
      `${SITE}/api/order-status?session_id=`,
    ]) {
      const res = await orderStatus.GET(new Request(url));
      assert.equal(res.status, 400, url);
      assert.equal((await res.json() as { error: string }).error, "invalid-session-id");
    }
    assert.equal(touched, 0);
  });
});

test("order-status: reports the same state the page renders", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["digital", { format: "digital" }, "digital-ready"],
    ["canvas", { format: "canvas" }, "physical"],
    ["refunded", { format: "digital", status: "refunded" }, "revoked"],
  ];
  for (const [label, over, expected] of cases) {
    await withBindings({ ORDERS_DB: memoryStore({ [SESSION]: record(over) }) }, async () => {
      const res = await orderStatus.GET(
        new Request(`${SITE}/api/order-status?session_id=${SESSION}`),
      );
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { state: expected }, label);
      // The poller runs on a timer for two minutes; it must never be cached.
      assert.equal(res.headers.get("Cache-Control"), "private, no-store", label);
    });
  }
});

test("order-status: no record is a 200 pending, not a 404", async () => {
  // It is the first seconds after payment, not a missing resource, and the
  // poller treats a non-200 as "stop asking".
  await withBindings({ ORDERS_DB: memoryStore() }, async () => {
    const res = await orderStatus.GET(
      new Request(`${SITE}/api/order-status?session_id=${SESSION}`),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "digital-pending" });
  });
});

test("order-status: a broken store is a 503 the poller retries", async () => {
  await withBindings({}, async () => {
    const res = await orderStatus.GET(
      new Request(`${SITE}/api/order-status?session_id=${SESSION}`),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, "orders-store-unavailable");
  });
  await withBindings(
    {
      ORDERS_DB: {
        ...memoryStore(),
        async getOrder(): Promise<string | null> {
          throw new Error("store down");
        },
      },
    },
    async () => {
      const res = await orderStatus.GET(
        new Request(`${SITE}/api/order-status?session_id=${SESSION}`),
      );
      assert.equal(res.status, 503);
    },
  );
});

test("order-status: a corrupt record is a 500, not a state the page would trust", async () => {
  await withBindings({ ORDERS_DB: memoryStore({ [SESSION]: "not json" }) }, async () => {
    const res = await orderStatus.GET(
      new Request(`${SITE}/api/order-status?session_id=${SESSION}`),
    );
    assert.equal(res.status, 500);
    assert.equal((await res.json() as { error: string }).error, "corrupt-order");
  });
});

test("order-status never reads the masters bucket", async () => {
  // The whole reason this endpoint exists separately from /api/download: it
  // answers "is it ready yet" without pulling bytes of the full-resolution file.
  let mastersTouched = 0;
  const masters = {
    async get() {
      mastersTouched++;
      return null;
    },
  };
  await withBindings({ ORDERS_DB: memoryStore({ [SESSION]: record() }), MASTERS: masters }, async () => {
    await orderStatus.GET(new Request(`${SITE}/api/order-status?session_id=${SESSION}`));
  });
  assert.equal(mastersTouched, 0);
});

// ---- the page's own markup ----
//
// Asserted against the page source rather than its rendered output: the node
// test runner strips types, it does not transform .tsx, so page.tsx cannot be
// imported here. tests/site-header.test.mts establishes that convention, and the
// assertions below are the same shape — what must be true of the markup.

const PAGE = readFileSync(
  new URL("../src/app/checkout/success/page.tsx", import.meta.url),
  "utf8",
);

test("the download link is a plain <a>, never a <Link>", () => {
  // The load-bearing acceptance criterion from #103. <Link> to a Route Handler
  // prefetches on scroll, so merely rendering the page used to run the KV lookup
  // and start streaming the full-resolution master before any click. Nothing
  // else in this file can catch a revert to <Link>, so it is asserted directly.
  assert.doesNotMatch(
    PAGE,
    /<Link[^>]*\/api\/download/,
    "a <Link> to /api/download would prefetch the master file again",
  );
  assert.match(PAGE, /<a\s+[\s\S]*?href=\{downloadHref\}/);
  // `download` is what tells the browser to save rather than navigate. It is
  // load-bearing twice over now: the link carries a token, so a stray prefetch
  // would spend one of the customer's downloads (#111).
  assert.match(PAGE, /href=\{downloadHref\}\s*\n\s*download\b/);
});

test("the download href exists in exactly one place on the page", () => {
  // One link, in the digital-ready branch. A second would mean a physical order
  // could be offered a download again.
  // The page never spells the download URL itself any more — it renders
  // `downloadHref`, which only download-token.ts builds — so the single
  // spelling of the route lives in one module, not in markup.
  const occurrences = PAGE.split("href={downloadHref}").length - 1;
  assert.equal(occurrences, 1, `the download link appears ${occurrences} times`);
  assert.doesNotMatch(PAGE, /\/api\/download\?/);
});

test("every page state has a branch, so none falls through to a bare thank-you", () => {
  for (const state of [
    "missing-session",
    "invalid-session",
    "physical",
    "digital-ready",
    "digital-no-token",
    "revoked",
    "digital-unavailable",
    "unavailable",
  ]) {
    assert.match(PAGE, new RegExp(`"${state}"`), `no branch for ${state}`);
  }
});

test("the unavailable branch tells the truth and does not poll", () => {
  // "unavailable" means a record exists under this session id and cannot be
  // parsed. It used to fall through to the processing branch, which claimed we
  // were preparing the download and mounted a poller that then retried
  // /api/order-status -- a guaranteed 500 corrupt-order -- until its deadline.
  const start = PAGE.indexOf('state === "unavailable"');
  assert.ok(start > 0, 'no branch for "unavailable"');
  const branch = PAGE.slice(start, PAGE.indexOf('state === "digital-unavailable"', start));

  // No poller: nothing about a corrupt record changes on its own, so retrying
  // only spends the customer's two minutes to reach the same 500.
  assert.doesNotMatch(
    branch,
    /sessionId=\{sessionId\}/,
    "the unavailable branch must not mount OrderStatusPoller",
  );
  // And it must not claim the order is still being prepared.
  assert.doesNotMatch(
    branch,
    /preparing your download/i,
    "a corrupt record is not a processing order",
  );
  // The reference is still shown, so the customer has something to quote.
  assert.match(branch, /reference=\{reference\}/);
});

test("the page prints a short reference, never the raw session id", () => {
  // The full id identifies the order and was, until #111, also the bearer
  // credential for the download route. It reaches no markup at all now.
  assert.match(PAGE, /sessionId\.slice\(-8\)\.toUpperCase\(\)/);
  assert.doesNotMatch(
    PAGE,
    /encodeURIComponent\(sessionId\)/,
    "the session id must not reach the download href or any attribute",
  );
  // Visible copy takes the truncated reference, never the id itself.
  assert.match(PAGE, /Order reference <span className="font-medium">\{props\.reference\}<\/span>/);
  // And no <code> block renders the id, which is how the page used to leak it.
  assert.doesNotMatch(PAGE, /\{sessionId\}\s*<\/code>/);
});

test("the page degrades to a rendered state rather than throwing", async () => {
  // resolveCheckoutPageState returns a state for every input including a broken
  // store, so the page has nothing left to fail on. Asserted on the resolver,
  // which is the part that actually touches KV.
  await withBindings({}, async () => {
    assert.equal(await resolveCheckoutPageState(SESSION), "processing");
    assert.equal(await resolveCheckoutPageState(undefined), "missing-session");
  });
});

test("the poller stops on a terminal state instead of polling forever", () => {
  const POLLER = readFileSync(
    new URL("../src/app/checkout/success/OrderStatusPoller.tsx", import.meta.url),
    "utf8",
  );
  // Anything other than pending is final, and the poller must not keep asking
  // about a revoked or unavailable order.
  assert.match(POLLER, /state === "digital-pending"/);
  assert.match(POLLER, /typeof state === "string"/);
  // And it gives up rather than running until the tab closes.
  assert.match(POLLER, /deadline/);
});

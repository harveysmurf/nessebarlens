import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import Stripe from "stripe";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { SAMPLE_SLUG } from "./fixtures/sample-photo.mts";
import { decideFulfillment, parseOrderRecord } from "../src/domain/ordering/order-decision.ts";
import {
  paymentIntentForDispute,
  revokeOrderByPaymentIntent,
} from "../src/application/fulfillment/order-revocation.ts";
import {
  isChargeId,
  isPaymentIntentId,
  isStripeNotFound,
} from "../src/infrastructure/stripe/stripe-ids.ts";
import type { StripeSessionLookup } from "../src/domain/ordering/stripe-session-lookup.ts";
import { readStripeEvent, type StripeCheckoutSession } from "../src/infrastructure/stripe/stripe-event.ts";
import { STRIPE_API_VERSION } from "../src/infrastructure/stripe/stripe.ts";
import {
  pickCheckoutEvent,
  pickEvent,
  scrub,
  STRIPE_API_VERSION as CAPTURE_API_VERSION,
  testModeKey,
} from "../scripts/capture-stripe-fixtures.mjs";

/* Stripe contract tests (#225).

   Dependabot PRs get no repository secrets, so a bump of the `stripe` package
   (group `payments`) cannot be checked against the live API there. What it can
   be checked against is the shape of what Stripe sends and the SDK's own
   signature verification, both of which these tests exercise with no key and no
   network:

     - real `Stripe.webhooks.constructEvent` accepts a correctly signed fixture
       and rejects a tampered body or wrong secret;
     - the REAL webhook route turns the checkout fixture into a stored order;
     - the refund and dispute fixtures carry the fields the revocation path reads;
     - the fixtures all share the webhook endpoint's API version.

   Compile-time shape checks against the SDK types live in
   src/infrastructure/stripe/stripe-event.ts and run under `npm run typecheck`.

   The fixtures are real sandbox captures, scrubbed of personal data by
   `node scripts/capture-stripe-fixtures.mjs` (see tests/fixtures/stripe/README.md). */

/* The API version the webhook payloads are rendered at. Stripe renders an event
   at the webhook ENDPOINT's API version, falling back to the account default;
   the staging endpoint has api_version null, so it follows the account default.
   The client pin STRIPE_API_VERSION (src/infrastructure/stripe/stripe.ts) only governs API
   requests, so it need not equal this. Changing this is a Stripe-dashboard
   decision; when it changes, re-capture the fixtures and update this constant. */
const WEBHOOK_API_VERSION = "2026-08-26.dahlia";

const FAKE = "buzz-test:fake-worker-bindings";

type Fake = {
  ORDERS_DB?: unknown;
  webhookSecret?: string;
  prodigiWebhookToken?: string;
  prodigiKeyConfigured: boolean;
};

const globals = globalThis as { __buzzBindings?: Fake };
globals.__buzzBindings = { prodigiKeyConfigured: false };

// Same seam as routes.test.mts: the Worker bindings module is the only thing
// substituted; the route and everything under it is the real source.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/infrastructure/cloudflare/worker-bindings") {
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

const route = await import("../src/app/api/webhooks/stripe/route.ts");

function loadFixture(name: string): Stripe.Event {
  const url = new URL(`./fixtures/stripe/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Stripe.Event;
}

const FIXTURE_NAMES = [
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
] as const;

const fixtures = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, loadFixture(name)]),
) as Record<(typeof FIXTURE_NAMES)[number], Stripe.Event>;

/** A fresh secret per run: nothing here is, or looks like, a real credential. */
const secret = `whsec_${randomBytes(24).toString("hex")}`;

function signed(event: Stripe.Event, withSecret = secret) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: withSecret,
  });
  return { payload, header };
}

// The route tests swap the bindings, fetch and env; this puts all three back
// after every test so one test's world never reaches the next.
let snapshot: { bindings: unknown; fetch: typeof fetch; env: NodeJS.ProcessEnv };
beforeEach(() => {
  snapshot = {
    bindings: globals.__buzzBindings,
    fetch: globalThis.fetch,
    env: { ...process.env },
  };
});
afterEach(() => {
  globals.__buzzBindings = snapshot.bindings as Fake;
  globalThis.fetch = snapshot.fetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot.env)) delete process.env[key];
  }
  Object.assign(process.env, snapshot.env);
});

for (const name of FIXTURE_NAMES) {
  test(`${name}: the SDK verifies a signed fixture and rejects tampering`, () => {
    const event = fixtures[name];
    const { payload, header } = signed(event);

    const verified = Stripe.webhooks.constructEvent(payload, header, secret);
    assert.equal(verified.type, event.type);
    assert.equal(verified.id, event.id);

    assert.throws(
      () => Stripe.webhooks.constructEvent(`${payload} `, header, secret),
      Stripe.errors.StripeSignatureVerificationError,
    );
    assert.throws(
      () =>
        Stripe.webhooks.constructEvent(
          payload,
          header,
          `whsec_${randomBytes(24).toString("hex")}`,
        ),
      Stripe.errors.StripeSignatureVerificationError,
    );
  });

  test(`${name}: readStripeEvent takes the real SDK path`, async () => {
    const event = fixtures[name];
    const { payload, header } = signed(event);
    // No `construct` override: this is the production call.
    const verified = await readStripeEvent(payload, header, secret);
    assert.equal(verified.type, event.type);
    assert.equal(verified.id, event.id);

    await assert.rejects(
      readStripeEvent(payload.replace("evt_", "evt_x"), header, secret),
      Stripe.errors.StripeSignatureVerificationError,
    );
  });

  test(`${name}: the fixture carries the webhook endpoint's API version`, () => {
    assert.equal(
      fixtures[name].api_version,
      WEBHOOK_API_VERSION,
      "webhook API version changed: re-capture fixtures with scripts/capture-stripe-fixtures.mjs and update WEBHOOK_API_VERSION",
    );
    assert.equal(fixtures[name].object, "event");
    assert.equal(fixtures[name].livemode, false);
  });
}

test("the API version pin has a Stripe-shaped value and is passed to the client", () => {
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  const source = readFileSync(
    new URL("../src/infrastructure/stripe/stripe.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /apiVersion:\s*STRIPE_API_VERSION/,
    "getStripe() must pass the pinned version, or an SDK bump moves the API version silently",
  );
});

test("checkout.session.completed: the real route stores the order the fixture describes", async () => {
  const event = fixtures["checkout.session.completed"];
  const session = event.data.object as unknown as StripeCheckoutSession;
  // The fixture was captured while the catalog carried the placeholder slug
  // `dawn`; the catalog now holds one published photo, so the metadata must name
  // a slug the order path resolves or the webhook stores the order as
  // unknown-photo. Patched here rather than pinned in the JSON so the fixture
  // stays a faithful capture and the test tracks the real catalog.
  session.metadata!.photoSlug = SAMPLE_SLUG;
  const store = memoryOrdersStore();
  const { payload, header } = signed(event);

  // The fixture's success_url origin is "ours" for this run. A physical order
  // needs a print-asset secret or the webhook (rightly) answers 5xx.
  process.env.PRINT_ASSET_HMAC_SECRET = "contract-test-print-asset-secret-32-chars";
  process.env.NEXT_PUBLIC_SITE_URL = new URL(session.success_url!).origin;
  globals.__buzzBindings = {
    webhookSecret: secret,
    ORDERS_DB: store,
    prodigiWebhookToken: "contract-test-callback-token",
    prodigiKeyConfigured: true,
  };
  process.env.PRODIGI_API_BASE = "https://api.sandbox.prodigi.com";
  process.env.PRODIGI_SANDBOX_API_KEY = "contract-test-sandbox-key";
  // Prodigi is stubbed; anything else reaching the network fails the test
  // instead of making a real request.
  const sent: Array<{ url: string; body: { recipient: { name: string; address: Record<string, string> } } }> = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (!String(url).startsWith("https://api.sandbox.prodigi.com/")) {
      throw new Error(`unexpected network call to ${String(url)}`);
    }
    sent.push({ url: String(url), body: JSON.parse(init!.body!) });
    return new Response(JSON.stringify({ order: { id: "ord_contract_1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const response = await route.POST(
    new Request(`${process.env.NEXT_PUBLIC_SITE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload,
    }),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  const raw = store.orders.get(session.id!);
  assert.ok(raw, "an order is stored under the Checkout Session id");
  const order = parseOrderRecord(raw);
  assert.ok(order);
  assert.equal(order.kind, "physical");
  assert.equal(order.sessionId, session.id);
  assert.equal(order.amountTotal, session.amount_total);
  assert.equal(order.photoSlug, session.metadata!.photoSlug);
  assert.equal(order.format, session.metadata!.format);
  assert.equal(order.size, session.metadata!.size);
  // "paid" means the amount, metadata and shipping checks all accepted the
  // fixture; a reason such as amount-mismatch would mean it and our rules disagree.
  assert.equal(order.status, "paid");
  assert.equal(order.reason, null);
  assert.equal(order.prodigiOrderId, "ord_contract_1");
  assert.equal(sent.length, 1, "one Prodigi order was placed");
  const shipping = session.collected_information!.shipping_details!;
  assert.equal(sent[0].body.recipient.address.townOrCity, shipping.address!.city);
  assert.equal(sent[0].body.recipient.address.countryCode, shipping.address!.country);
  assert.equal(order.recipient?.name, shipping.name);
  assert.equal(order.recipient?.line1, shipping.address!.line1);
  assert.equal(order.recipient?.city, shipping.address!.city);
  assert.equal(order.recipient?.postcode, shipping.address!.postal_code);
  assert.equal(order.recipient?.countryCode, shipping.address!.country);
  assert.equal(order.recipient?.email, session.customer_details!.email);
});

test("checkout.session.completed: a foreign success_url origin is dropped by the real route", async () => {
  const event = fixtures["checkout.session.completed"];
  const store = memoryOrdersStore();
  const { payload, header } = signed(event);
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  globals.__buzzBindings = {
    webhookSecret: secret,
    ORDERS_DB: store,
    prodigiKeyConfigured: false,
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const response = await route.POST(
      new Request("https://nessebarlens.com/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": header },
        body: payload,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(store.orders.size, 0);
  } finally {
    console.warn = warn;
  }
});

/** A paid order for the fixture's session, written the way the webhook does. */
function seededOrders() {
  const session = fixtures["checkout.session.completed"].data
    .object as unknown as StripeCheckoutSession;
  const decision = decideFulfillment({
    sessionId: session.id!,
    paymentStatus: session.payment_status ?? null,
    currency: session.currency ?? null,
    amountTotal: session.amount_total ?? null,
    metadata: session.metadata ?? null,
    shippingDetails: session.collected_information?.shipping_details ?? null,
    customerEmail: session.customer_details?.email ?? null,
    customerPhone: session.customer_details?.phone ?? null,
    prodigiKeyConfigured: false,
    now: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(decision.action, "write");
  const record = (decision as { record: unknown }).record;
  const store = memoryOrdersStore({
    orders: { [session.id!]: JSON.stringify(record) },
  });
  return { store, sessionId: session.id! };
}

function lookupFor(paymentIntent: string, sessionId: string, chargeId?: string) {
  const calls: string[] = [];
  const lookup: StripeSessionLookup = {
    async findSessionIdByPaymentIntent(pi) {
      calls.push(`session:${pi}`);
      return pi === paymentIntent ? sessionId : null;
    },
    async findPaymentIntentForCharge(charge) {
      calls.push(`charge:${charge}`);
      return charge === chargeId ? paymentIntent : null;
    },
    isPaymentReference: isPaymentIntentId,
    isChargeReference: isChargeId,
    isNotFound: isStripeNotFound,
  };
  return { lookup, calls };
}

test("charge.refunded: a full refund revokes the order the payment intent maps to", async () => {
  const charge = fixtures["charge.refunded"].data.object as Stripe.Charge;
  // The shapes the route reads: a string payment_intent and a full refund.
  // The real refund comes from its own PaymentIntent, not the checkout
  // fixture's, so the lookup below maps this fixture's PI to the seeded order.
  assert.equal(typeof charge.payment_intent, "string");
  assert.equal(charge.amount_refunded, charge.amount);

  const { store, sessionId } = seededOrders();
  const { lookup } = lookupFor(charge.payment_intent as string, sessionId);
  const outcome = await revokeOrderByPaymentIntent({
    store,
    status: "refunded",
    paymentIntent: charge.payment_intent as string,
    now: "2026-10-06T01:00:00.000Z",
    stripe: lookup,
  });
  assert.equal(outcome.httpStatus, 200);
  assert.equal(parseOrderRecord(store.orders.get(sessionId)!)?.status, "refunded");
});

test("charge.dispute.created: the charge resolves to the payment intent, then revokes", async () => {
  const dispute = fixtures["charge.dispute.created"].data.object as Stripe.Dispute;
  assert.equal(typeof dispute.charge, "string");
  // The dispute's own PaymentIntent (not the checkout fixture's), else a stub.
  const disputePi =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : "pi_stub_for_dispute";

  const { store, sessionId } = seededOrders();
  const { lookup, calls } = lookupFor(
    disputePi,
    sessionId,
    dispute.charge as string,
  );
  const paymentIntent = await paymentIntentForDispute(dispute, lookup);
  assert.equal(paymentIntent, disputePi);
  assert.deepEqual(calls, [`charge:${dispute.charge}`]);

  const outcome = await revokeOrderByPaymentIntent({
    store,
    status: "disputed",
    paymentIntent,
    now: "2026-10-06T02:00:00.000Z",
    stripe: lookup,
  });
  assert.equal(outcome.httpStatus, 200);
  assert.equal(parseOrderRecord(store.orders.get(sessionId)!)?.status, "disputed");
});

test("scrub replaces personal data and keeps the shape", () => {
  const sample = {
    id: "evt_1",
    request: { id: null, idempotency_key: "idem-123" },
    data: {
      object: {
        name: "Jane Roe",
        email: "jane@real.example",
        receipt_email: "jane@real.example",
        phone: "+359888123456",
        client_secret: "cs_secret",
        receipt_url: "https://pay.stripe.com/receipts/real",
        customer_details: {
          email: "jane@real.example",
          name: "Jane Roe",
          phone: "+359888123456",
          address: { city: "Sofia", line1: "5 Real St", line2: "Ap 3", postal_code: "1000", state: "SF", country: "BG" },
        },
        card: { last4: "1111", fingerprint: "RealPrint", ip_address: "1.2.3.4" },
        shipping: { name: "Jane Roe", address: null },
        metadata: { photoSlug: "dawn", format: "giclee" },
        amount: 2999,
        items: [{ email: "x@real.example" }],
      },
    },
  };
  const original = JSON.stringify(sample);
  const out = scrub(sample);
  assert.equal(JSON.stringify(sample), original, "scrub must not mutate its input");

  const text = JSON.stringify(out);
  for (const leak of ["Jane", "real.example", "888123456", "Sofia", "Real St", "1111", "RealPrint", "1.2.3.4", "idem-123", "cs_secret", "receipts/real"]) {
    assert.ok(!text.includes(leak), `scrubbed output still contains ${leak}`);
  }
  assert.equal(out.request.idempotency_key, null);
  assert.equal(out.data.object.customer_details.email, "buyer@example.com");
  assert.equal(out.data.object.customer_details.name, "Test Buyer");
  assert.equal(out.data.object.customer_details.phone, null);
  assert.equal(out.data.object.customer_details.address.city, "Nessebar");
  assert.equal(out.data.object.customer_details.address.line2, null);
  assert.equal(out.data.object.shipping.address, null);
  assert.equal(out.data.object.amount, 2999);
  assert.deepEqual(out.data.object.metadata, sample.data.object.metadata);
});

test("capture script pins the same API version as the app", () => {
  assert.equal(CAPTURE_API_VERSION, STRIPE_API_VERSION);
});

test("capture script: refuses non-test keys and picks the physical checkout", () => {
  assert.throws(() => testModeKey(undefined), /not set/);
  assert.throws(() => testModeKey("sk_live_abc"), /not test mode/);
  assert.equal(testModeKey("sk_test_abc"), "sk_test_abc");

  const meta = (format: string) => ({ photoSlug: "dawn", format, size: "", quoteEur: "5" });
  const digital = { id: "evt_d", data: { object: { metadata: meta("digital") } } };
  const noMeta = { id: "evt_n", data: { object: { metadata: {} } } };
  const physical = {
    id: "evt_p",
    data: {
      object: {
        metadata: meta("giclee"),
        collected_information: { shipping_details: { name: "x" } },
      },
    },
  };
  assert.equal(pickCheckoutEvent([noMeta, digital, physical])?.id, "evt_p");
  assert.equal(pickCheckoutEvent([noMeta, digital])?.id, "evt_d");
  assert.equal(pickCheckoutEvent([noMeta]), null);
  assert.equal(pickEvent("charge.refunded", [{ id: "a" }, { id: "b" }])?.id, "a");
  assert.equal(pickEvent("charge.refunded", []), null);
});

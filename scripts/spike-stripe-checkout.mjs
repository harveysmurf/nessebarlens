/**
 * SPIKE — the make-or-break unknown behind #126 and #134, and not a test yet.
 *
 * Both issues are blocked on one question: can a headless browser complete a
 * Stripe hosted Checkout Session and yield a real payment_intent? #134 is dead
 * because Stripe retired the server-side sessions/complete endpoint, so the
 * browser is the only remaining route. If Stripe's bot detection refuses a
 * headless Chromium, both issues need a different answer and the plan in #126
 * changes.
 *
 * This script answers exactly that and nothing else. It is not wired into CI,
 * not part of `npm test`, and deliberately asserts the minimum: a session was
 * created, the hosted page was reachable, the test card was accepted, and a
 * payment_intent came back. Whether the flow is worth keeping is a decision
 * made after this runs, not before.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/spike-stripe-checkout.mjs
 *
 * Test mode only: refuses a live key outright, since a real card path must
 * never be exercised by accident. Uses Stripe's canonical test card
 * 4242 4242 4242 4242, which cannot move money.
 */

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set");
  process.exit(1);
}
if (!key.startsWith("sk_test_")) {
  console.error("refusing to run: this spike only accepts a sk_test_ key");
  process.exit(1);
}

const { chromium } = await import("@playwright/test");

const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

// 1. Can we create the session at all? Independent of the browser, so a failure
//    here is a key or API problem and must not be read as a bot-detection result.
const session = await stripe.checkout.sessions.create({
  mode: "payment",
  success_url: "https://example.com/spike/paid",
  cancel_url: "https://example.com/spike/cancelled",
  // Same shape the real route sends, so the spike exercises the params Stripe
  // actually sees in production rather than a stripped-down variant.
  adaptive_pricing: { enabled: false },
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: 1234,
        product_data: { name: "Spike — high-resolution license" },
      },
    },
  ],
});
if (!session.url) fail(`no checkout url returned (id ${session.id})`);
console.log(`OK   session created: ${session.id}`);

// 2. Does Stripe serve the hosted page to a headless browser? Bot detection, if
//    any, fires here or on submit.
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const blocked = [];
page.on("response", (r) => {
  if (r.status() === 403 && /stripe\.com/.test(r.url())) {
    blocked.push(`${r.status()} ${r.url()}`);
  }
});

await page.goto(session.url, { waitUntil: "domcontentloaded" });
await page.locator("input[name=email]").fill("spike@example.com");
console.log("OK   hosted checkout page reachable in headless chromium");

if (blocked.length) console.warn(`WARN stripe returned 403: ${blocked.join(", ")}`);

// 3. Select the card method. The accordion row exposes an accessible button with
//    a zero-size bounding box, so neither Playwright's own click nor a locator
//    click lands: a coordinate click on the row is the only thing that selects
//    the radio. Getting this wrong looks exactly like Stripe blocking us — the
//    card fields simply never mount, with no error anywhere.
const cardRow = page.getByRole("button", { name: "Pay with card" });
const rowBox = await cardRow.boundingBox();
if (!rowBox) fail("no card row on the hosted page");
await page.mouse.click(rowBox.x + 5, rowBox.y + 5);

// The card inputs are in the top frame's DOM, not inside the
// `checkout-inner-origin-frame` iframe, so query the page directly.
await page.locator('input[autocomplete="cc-number"]').waitFor({ timeout: 30_000 });

// 4. Does the test card go through? 4242… is Stripe's own documented test card
//    and cannot charge a real account.
await page.locator('input[autocomplete="cc-number"]').fill("4242424242424242");
await page.locator('input[autocomplete="cc-exp"]').fill("1230");
await page.locator('input[autocomplete="cc-csc"]').fill("314");
await page.locator('input[autocomplete="cc-name"]').fill("Spike Tester");
await page.getByRole("button", { name: /^Pay$/ }).click();

await page.waitForURL(/spike\/(paid|cancelled)/, { timeout: 60_000 }).catch(() => {
  fail(`never reached the success_url; landed on ${page.url()}`);
});

const final = await stripe.checkout.sessions.retrieve(session.id);
if (final.payment_status !== "paid") fail(`payment_status is ${final.payment_status}`);
if (!final.payment_intent) fail("session has no payment_intent");

// The webhook is what actually writes the order record, and this spike does not
// stand up a server to receive it — that is the harness decision, not this
// unknown. Reaching a paid session with a payment_intent is the answer #134
// needs.
console.log(`OK   paid: payment_intent=${final.payment_intent}, intent_status=paid`);
console.log("SPIKE_RESULT PASS — a headless browser can complete Stripe hosted checkout");

await browser.close();
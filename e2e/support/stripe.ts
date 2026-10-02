/**
 * Guards and selectors shared by the #143 browser specs.
 *
 * Everything here exists because of a specific way the flow fails that looks
 * like something else entirely.
 */

/**
 * Refuse to run against a live Stripe key, before a browser is launched.
 *
 * The flow drives a real hosted Checkout page, so a live key would mean a real
 * card path in a CI job — the one failure mode with a monetary cost. The spike
 * had this guard and it is reused verbatim: the key is read from the same env
 * the app reads, because a spec that checked its own variable while the server
 * ran on another would pass the guard and still charge a real card.
 *
 * Returns the key, or undefined when the flow should be skipped because no
 * sandbox key is configured. An absent key is a skip (a contributor running
 * the suite locally has no Stripe account); a present non-test key is a hard
 * failure.
 */
export function stripeTestKey(): string | undefined {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return undefined;
  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "refusing to run the E2E flow: STRIPE_SECRET_KEY is not a sk_test_ key. " +
        "The browser flow drives a real Stripe Checkout page and must never " +
        "run against a live account.",
    );
  }
  return key;
}

/** Stripe's own documented test card. Cannot move money. */
export const TEST_CARD = {
  number: "4242424242424242",
  exp: "1230",
  csc: "314",
  name: "E2E Tester",
} as const;

/**
 * Select the card payment method on Stripe's hosted page.
 *
 * The accordion row's accessible button has a zero-size bounding box, so both
 * `locator.click()` and `element.click()` fail with a visibility/interception
 * error that retries until timeout. The symptom is identical to Stripe blocking
 * automation — no error on the page, but the card fields never mount — so this
 * is the one place a coordinate click is correct rather than a workaround.
 */
export async function selectCardMethod(page: import("@playwright/test").Page) {
  const row = page.getByRole("button", { name: /pay with card/i });
  const box = await row.boundingBox();
  if (!box) throw new Error("no card payment row on the Stripe checkout page");
  await page.mouse.click(box.x + 5, box.y + 5);
}

/**
 * Fill Stripe's card fields.
 *
 * These inputs are in the TOP frame's DOM, not inside the
 * `checkout-inner-origin-frame` iframe — searching that iframe finds nothing.
 */
export async function fillCard(page: import("@playwright/test").Page) {
  await page.locator('input[autocomplete="cc-number"]').waitFor({ timeout: 30_000 });
  await page.locator('input[autocomplete="cc-number"]').fill(TEST_CARD.number);
  await page.locator('input[autocomplete="cc-exp"]').fill(TEST_CARD.exp);
  await page.locator('input[autocomplete="cc-csc"]').fill(TEST_CARD.csc);
  await page.locator('input[autocomplete="cc-name"]').fill(TEST_CARD.name);
  await fillBillingAddress(page);
}

/**
 * Fill whatever the billing block requires beyond the card.
 *
 * The trace is what found this: on a GitHub runner Stripe renders a billing
 * address ZIP and a phone number inside the Link block, both empty and both
 * marked `[invalid]`, and clicking Pay then does nothing at all — the page
 * just sits there until the spec's own timeout, which reads as "Stripe never
 * redirected" rather than as a form this suite forgot to fill. The same flow
 * passed locally, so a hardcoded field list would have kept the divergence
 * hidden.
 *
 * So each field is filled only if it is present, and only if it is still
 * empty: Stripe decides which fields a session needs from the account's
 * settings, so the set differs between a local sandbox session and a CI one,
 * and a country preset by the browser (the runner defaults to US) may already
 * have supplied one. Nothing here is required to exist, so a session with no
 * billing block at all is still a valid pass.
 */
export async function fillBillingAddress(page: import("@playwright/test").Page) {
  // The tokens are the ones Stripe actually shipped on the failing CI run
  // (`autocomplete="billing postal-code"` and `autocomplete="tel"`, read out of
  // the uploaded trace), not the ones a US form is usually expected to use.
  for (const [name, value] of [
    ["postal-code", "10001"],
    ["tel", "2015550123"],
  ] as const) {
    const field = page.locator(`input[autocomplete*="${name}"]`).first();
    if ((await field.count()) === 0) continue;
    if (((await field.inputValue().catch(() => "")) || "").trim() !== "") continue;
    await field.fill(value);
  }
}
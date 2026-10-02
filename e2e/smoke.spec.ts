import { expect, test } from "@playwright/test";
import { DIGITAL_PRICE_EUR } from "@/lib/pricing";
import {
  selectCardMethod,
  fillCard,
  stripeTestKey,
  TEST_CARD,
} from "./support/stripe";

/**
 * The #143 happy path: home → photo → configurator → price → checkout redirect
 * → success page.
 *
 * Run against `next dev` with the seeded ORDERS (see playwright.config.ts), so
 * this spec and success-states.spec.ts share one server and one fixture.
 *
 * Two flows, split by what they need:
 *
 *   - digital licence: no Prodigi call anywhere, so it runs on a bare dev server
 *     and is the flow that can gate every pull request.
 *   - physical print: needs a Prodigi quote, so it runs only against the Prodigi
 *     sandbox and is skipped rather than failed when no sandbox key is set.
 *     Never a live account: quotePhysical goes through prodigi-config's
 *     allowlist, and a sandbox key is what the preview environment carries.
 *
 * Both are tagged `@hosted` and that tag is load-bearing, not decoration: the
 * describe title is what `--grep` matches, and ci.yml splits the suite on it
 * into a required job and a soft-failed one. These are the only specs that
 * leave our pages for checkout.stripe.com, and Stripe now gates that page
 * behind a bot check (hCaptcha) and an explicit "I am an AI agent" attestation
 * we will not click. So they run as signal, never as a gate — see the
 * `e2e-hosted-checkout` job. The live-key guard below is deliberately untagged
 * and stays in the required job: it drives no browser and fails closed on a
 * real-money mistake.
 *
 * Anything added to this describe inherits `@hosted`. A new spec that does not
 * touch Stripe's hosted page belongs outside it, or the required job silently
 * stops covering it.
 */

const sandboxProdigiKey = process.env.PRODIGI_SANDBOX_API_KEY?.trim();
const hasStripe = Boolean(stripeTestKey());

// The guard throws on a live key at module load, before any browser starts.
test.describe("@hosted checkout smoke flow", () => {
  test.skip(!hasStripe, "no sk_test_ STRIPE_SECRET_KEY configured");

  test("home → photo → configurator → price → Stripe → success page", async ({
    page,
  }) => {
    await page.goto("/");

    // The gallery is the front door; at least one print card must be present or
    // the rest of the flow is testing a 404.
    const firstCard = page.locator('a[href^="/prints/"]').first();
    await expect(firstCard).toBeVisible();
    await firstCard.click();

    await expect(page).toHaveURL(/\/prints\/[a-z0-9-]+$/);

    // Digital licence, chosen explicitly: the configurator opens on the
    // default format, which is physical, so without this the price label holds
    // a Prodigi quote (or "—") and there is nothing to assert. Once digital is
    // selected the configurator prices it itself, so the price is visible with
    // no network call and no quote to wait for — which is also why this flow is
    // the one that can run without Prodigi.
    // The label, not the input: the radio is sr-only behind its label, so
    // check() on the input is a click the label's own div intercepts forever.
    await page.getByText(/digital copy/i).click();
    const price = page.getByText(`€${DIGITAL_PRICE_EUR.toFixed(2)}`).first();
    await expect(price).toBeVisible();

    // The Checkout button stays disabled until the client has priced the
    // selection, so an enabled button is the assertion that the configurator
    // actually settled rather than merely rendering.
    const checkout = page.getByRole("button", { name: /checkout with stripe/i });
    await expect(checkout).toBeEnabled();

    // The redirect target comes from our own /api/checkout response, so the
    // flow asserts we really left for Stripe rather than staying put.
    await Promise.all([
      page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 }),
      checkout.click(),
    ]);

    await page.locator("input[name=email]").fill("e2e@example.com");
    await selectCardMethod(page);
    await fillCard(page);
    await page.getByRole("button", { name: /^Pay$/ }).click();

    await page.waitForURL(/\/checkout\/success\?session_id=cs_test_/, {
      timeout: 60_000,
    });

    // The live session's id is not in the seeded ORDERS — it cannot be, it was
    // minted by Stripe seconds ago — so the page renders "preparing your
    // download" until a webhook would have written the record. That is the
    // correct state here and asserting it pins the degradation path to a test
    // rather than to a customer's first minutes after paying.
    await expect(page.getByText(/we are preparing your download/i)).toBeVisible();

    // The session id is a bearer credential for /api/download (#111), so the
    // page prints only the last 8 characters — and the reference the customer
    // is told to quote must be exactly that.
    const sessionId = new URL(page.url()).searchParams.get("session_id")!;
    await expect(page.getByText(sessionId.slice(-8).toUpperCase())).toBeVisible();
  });

  test.describe("physical print", () => {
    test.skip(
      !sandboxProdigiKey,
      "no PRODIGI_SANDBOX_API_KEY configured — Prodigi is stubbed or sandbox, never a live account",
    );

    test("quotes from the Prodigi sandbox and reaches Stripe", async ({ page }) => {
      await page.goto("/prints/dawn");

      // Default format is physical, so the configurator must call /api/quote
      // and replace "—" with a real number before Checkout unlocks.
      const checkout = page.getByRole("button", { name: /checkout with stripe/i });
      await expect(checkout).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByText(/shipping estimate/i)).toBeVisible();

      await Promise.all([
        page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 }),
        checkout.click(),
      ]);
      await expect(page.locator("input[name=email]")).toBeVisible();

      // Cancelling exercises the other half of the redirect pair.
      await page.goto("/checkout/cancel?slug=dawn");
      await expect(page.getByRole("heading")).toBeVisible();
    });
  });
});

test("the live-key guard refuses a non-test Stripe key", async () => {
  // Asserted as a test rather than trusted as a comment: the guard is the only
  // thing standing between this suite and a real card, so it is the one piece
  // of the harness that must fail loudly if it regresses.
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_live_should_never_run";
  try {
    expect(() => stripeTestKey()).toThrow(/not a sk_test_ key/);
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
  expect(TEST_CARD.number).toBe("4242424242424242");
});
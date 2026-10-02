import { defineConfig, devices } from "@playwright/test";

/**
 * E2E browser harness for #143 — home → photo → configurator → price → Stripe
 * checkout → success page, plus the success page's three states.
 *
 * Always `next dev`, never the deployed preview (Architect, on #143): a preview
 * deploy is for verifying a deployment, and coupling a smoke flow to it means
 * every red run has two possible causes. `preview.yml` stays browser-free.
 *
 * The dev server is deliberately NOT `next build && next start`: a production
 * build inlines NEXT_PUBLIC_* and asserts it is present, which is a second
 * thing that can fail for reasons unrelated to the flow under test. It would
 * also set NODE_ENV=production, which the ORDERS seed refuses to run under.
 */

const DEV_PORT = 3100;
const baseURL = `http://127.0.0.1:${DEV_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Stripe's hosted checkout is a third party that occasionally returns a 5xx
  // or drops a frame; one retry absorbs that without hiding a real regression
  // in our own pages, which fail deterministically.
  retries: process.env.CI ? 1 : 0,
  // Serial, not parallel: every spec drives one shared next dev server and the
  // Stripe session rate limit is per-account. A minute each is generous for a
  // browser flow and keeps the job inside the CI budget.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Stripe's card inputs are in the top frame and its radio row has a
    // zero-size box; both are handled explicitly in the specs, so no global
    // force/click hacks are needed anywhere.
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(DEV_PORT),
      NEXT_PUBLIC_SITE_URL: baseURL,
      // Any sk_test_ key is accepted; the flow is only ever run against
      // Stripe's sandbox, where 4242… cannot move money. support/stripe.ts
      // asserts that as a test rather than trusting this comment.
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_e2e_placeholder",
      // Prodigi is explicit-host by design: prodigiApiBase() throws unless
      // PRODIGI_API_BASE is set to an allowlisted host, so the server needs the
      // sandbox base and its paired key or /api/quote answers 503 and the
      // physical-print spec waits on a Checkout button that can never enable.
      // The key only reaches the server when it is present, so a bare dev run
      // without one still leaves that spec skipped rather than misconfigured.
      PRODIGI_API_BASE: "https://api.sandbox.prodigi.com",
      ...(process.env.PRODIGI_SANDBOX_API_KEY
        ? { PRODIGI_SANDBOX_API_KEY: process.env.PRODIGI_SANDBOX_API_KEY }
        : {}),
      // A physical order cannot be charged without this one: /api/checkout
      // fails closed (503 "Print fulfillment is not configured") when it cannot
      // sign a master asset URL, so without it the physical-print spec waits on
      // a Checkout button that can never enable. The value only has to sign —
      // the flow asserts the redirect to Stripe, not a download.
      ...(process.env.PRINT_ASSET_HMAC_SECRET
        ? { PRINT_ASSET_HMAC_SECRET: process.env.PRINT_ASSET_HMAC_SECRET }
        : {}),
      // The three success-page states. Without this the page can only ever
      // render "processing" on a dev server, because ORDERS is a Worker
      // binding with no env fallback.
      ORDERS_DEV_SEED: "e2e/fixtures/orders-seed.json",
    },
  },
});
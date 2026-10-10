import { defineConfig, devices } from "@playwright/test";

/**
 * E2E browser harness for #143 — home → photo → configurator → price → Stripe
 * checkout → success page, plus the success page's three states.
 *
 * Always `next dev`, never the deployed preview (Architect, on #143): a preview
 * deploy is for verifying a deployment, and coupling a smoke flow to it means
 * every red run has two possible causes. `preview.yml` stays browser-free.
 *
 * `E2E_BASE_URL` is the one exception, and it is opt-in per invocation rather
 * than a second mode anyone can drift into: unset means exactly the harness
 * above, so no CI job can reach a deployed host by accident. Set, it points the
 * same specs at a deployed environment and starts no server. That is the only
 * way to exercise a real deployment's routes and bindings — the dev server
 * answers from `next dev`, so it never proves the Worker serves them.
 *
 * The dev server is deliberately NOT `next build && next start`: a production
 * build inlines NEXT_PUBLIC_* and asserts it is present, which is a second
 * thing that can fail for reasons unrelated to the flow under test. It would
 * also set NODE_ENV=production, which the ORDERS seed refuses to run under.
 */

const DEV_PORT = 3100;

/**
 * A deployed host to run against instead of the dev server. Validated rather
 * than interpolated: a typo'd or truncated value would silently become a
 * baseURL that resolves nowhere, and the symptom is a spec timeout on the
 * first `page.goto` — which reads as a broken deployment.
 */
const REMOTE_BASE_URL = (() => {
  const raw = process.env.E2E_BASE_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`E2E_BASE_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `E2E_BASE_URL must be http(s), got ${parsed.protocol} in ${JSON.stringify(raw)}`,
    );
  }
  // Normalised so page.goto("/") and an absolute assertion in a spec agree.
  return parsed.origin;
})();

const baseURL = REMOTE_BASE_URL ?? `http://127.0.0.1:${DEV_PORT}`;

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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Stripe's hosted checkout gates its submit on an hCaptcha token, and
        // headless Chromium on a runner does not get one — the click resolves
        // and the page never navigates. `HEADED=1` (ci.yml runs it under Xvfb)
        // is the opt-in; a local run stays headless because it needs no display
        // and gets a token either way.
        headless: process.env.HEADED !== "1",
      },
    },
  ],
  // The success-page states are asserted against ORDERS fixtures that only the
  // dev server below is seeded with (ORDERS is a Worker binding with no env
  // fallback). Against a deployed host they would be five guaranteed reds
  // against unknown session ids, so they are not offered there — not skipped
  // silently, but kept out of the selection. The local run above is where that
  // coverage lives and it stays required in CI, so nothing is lost.
  ...(REMOTE_BASE_URL ? { testIgnore: "**/success-states.spec.ts" } : {}),
  webServer: REMOTE_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          PORT: String(DEV_PORT),
          NEXT_PUBLIC_SITE_URL: baseURL,
          // The derivative ladder base, so the gallery and the print preview
          // render a real `<picture>`/`<img>` in the flow specs (#326) instead
          // of the alt-text fallback. The host is deliberately unresolvable:
          // print-preview.spec.ts fulfils its image requests with a small
          // opaque pixel, so nothing here reaches a CDN. Server-side only — the
          // client gets the resolved URLs as props.
          NEXT_PUBLIC_WEB_IMAGES_BASE: "https://images.e2e.test",
          // Any sk_test_ key is accepted; the flow is only ever run against
          // Stripe's sandbox, where 4242… cannot move money. support/stripe.ts
          // asserts that as a test rather than trusting this comment.
          STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_e2e_placeholder",
          // Prodigi is explicit-host by design: prodigiApiBase() throws unless
          // PRODIGI_API_BASE is set to an allowlisted host, so the server needs
          // the sandbox base and its paired key or /api/quote answers 503 and the
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
          // The contact page reads this at request time (it is force-dynamic) to
          // render the Turnstile widget. Cloudflare's always-pass test site key
          // lets the contact spec render a real widget without a secret or a
          // live challenge.
          NEXT_PUBLIC_TURNSTILE_SITE_KEY:
            process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
        },
      },
});
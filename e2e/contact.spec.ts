import { expect, test } from "@playwright/test";

/**
 * Contact form (#293).
 *
 * Untagged, so it runs in the required `e2e-smoke` job with no secrets. It
 * exercises the client side only: the page renders its labelled fields, empty
 * submission surfaces accessible per-field errors, and the header links here.
 * The server side (Turnstile fail-closed, the Resend send, the rate limit) is
 * covered by the route tests in tests/contact-route.test.mts, which drive the
 * real handler with a fake provider — an actual submit here would either need a
 * live Siteverify call or a fake the browser cannot see.
 *
 * The validation assertions run before any token check, so they do not depend
 * on the Turnstile widget solving a challenge.
 */
test.describe("contact form (#293)", () => {
  test("renders the labelled fields and reports empty-field errors accessibly", async ({
    page,
  }) => {
    await page.goto("/contact");

    await expect(
      page.getByRole("heading", { name: /contact the studio/i }),
    ).toBeVisible();
    const name = page.getByLabel("Name");
    await expect(name).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Message")).toBeVisible();

    await page.getByRole("button", { name: /send message/i }).click();

    await expect(page.getByText("Please enter your name.")).toBeVisible();
    await expect(page.getByText("Please enter your email address.")).toBeVisible();
    await expect(page.getByText("Please enter a message.")).toBeVisible();

    // The error is wired to the field, not only shown near it.
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAttribute("aria-describedby", "contact-name-error");
  });

  test("the header links to the contact page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contact" }).click();
    await expect(page).toHaveURL(/\/contact$/);
    await expect(
      page.getByRole("heading", { name: /contact the studio/i }),
    ).toBeVisible();
  });
});

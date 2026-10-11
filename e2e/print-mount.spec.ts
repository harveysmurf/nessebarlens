import { expect, test, type Page } from "@playwright/test";

/**
 * The framed mount choice (#335): White Mount (the default) and No Mount.
 *
 * These run against the dev server with the real compiled catalog. The harbour
 * master's framed offer is 20×30, 30×40, 30×45, 40×60; unmounted, the first
 * three clear the framed PPI floor and 40×60 does not — so this spec can assert
 * both the offered case and the disabled one with its reason.
 *
 * The No Mount *checkout* test stubs /api/quote and /api/checkout: the client's
 * job is to post the unmounted selection, and the quote is not the subject.
 * That the mount then resolves to the GLOBAL-CFP-* SKU server-side is proven in
 * tests/routes.test.mts against the Prodigi request body.
 */

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";

function preview(page: Page) {
  return page.locator("[data-preview-kind]");
}

async function chooseFramed(page: Page) {
  await page.goto(`/prints/${HARBOUR}`);
  await page.getByText(/framed print/i).click();
  await expect(preview(page)).toHaveAttribute("data-preview-kind", "framed");
}

test.describe("framed mount choice (#335)", () => {
  test("No Mount drops the mount layer and fills the glaze", async ({ page }) => {
    await chooseFramed(page);
    // 30×40 is offered mounted and unmounted for this master.
    await page.locator("#print-size").selectOption("30x40");

    // Mounted first: the mount rect exists and the window sits inside it.
    await expect(preview(page).locator("[data-mount]")).toHaveCount(1);
    const mountedWindow = (await preview(page)
      .locator("[data-window]")
      .boundingBox())!;

    await page.locator("#frame-mount").selectOption("none");
    await expect(page.locator("#frame-mount")).toHaveValue("none");
    await expect(preview(page).locator("[data-mount]")).toHaveCount(0);
    // The label names the mount, so the choice is legible to a screen reader.
    await expect(preview(page)).toHaveAttribute("aria-label", /no mount/i);

    const unmountedWindow = (await preview(page)
      .locator("[data-window]")
      .boundingBox())!;
    // Unmounted, the window is the full glaze, so it is strictly wider than
    // the mount window it replaced (same frame, same size).
    expect(unmountedWindow.width).toBeGreaterThan(mountedWindow.width);

    // Switching back restores the mount layer.
    await page.locator("#frame-mount").selectOption("white");
    await expect(preview(page).locator("[data-mount]")).toHaveCount(1);
  });

  test("No Mount is disabled, with a reason, where the print is too small", async ({
    page,
  }) => {
    await chooseFramed(page);
    // Harbour's framed offer includes 40×60; unmounted it is below the PPI
    // floor, so the option is disabled rather than silently swapped.
    await page.locator("#print-size").selectOption("40x60");
    await expect(
      page.locator('#frame-mount option[value="none"]'),
    ).toBeDisabled();
    await expect(page.locator("#frame-mount-help")).toHaveText(
      /resolution is too low/i,
    );
  });

  test("a No Mount checkout posts the unmounted selection", async ({ page }) => {
    let checkoutBody: Record<string, unknown> | null = null;
    await page.route("**/api/quote", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ merchandiseEur: 42, shippingEur: 5 }),
      }),
    );
    await page.route("**/api/checkout", async (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "stubbed" }),
      });
    });

    await chooseFramed(page);
    await page.locator("#print-size").selectOption("30x40");
    await page.locator("#frame-mount").selectOption("none");

    const checkout = page.getByRole("button", {
      name: /checkout with stripe/i,
    });
    await expect(checkout).toBeEnabled({ timeout: 15_000 });
    await checkout.click();

    await expect.poll(() => checkoutBody !== null).toBe(true);
    expect(checkoutBody!.format).toBe("framed");
    expect(checkoutBody!.mount).toBe("none");
  });
});

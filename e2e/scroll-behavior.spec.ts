import { expect, test } from "@playwright/test";

/**
 * Smooth scrolling during route transitions (#331 follow-up).
 *
 * `scroll-smooth` on `<html>` sets `scroll-behavior: smooth`. Next 16 no longer
 * overrides that during a client-side route change unless `<html>` also carries
 * `data-scroll-behavior="smooth"`; when it is missing, `next dev` logs
 * "Detected `scroll-behavior: smooth` on the `<html>` element" on the first
 * non-hash navigation. The source guard in tests/scroll-behavior.test.mts only
 * proves the attribute is written — this proves Next actually consumes it.
 *
 * Untagged, so it runs in the required `e2e-smoke` job with no secrets.
 */
test.describe("scroll behavior (#331 follow-up)", () => {
  test.use({ viewport: { width: 375, height: 844 } });

  test("a client navigation carries the data attribute and logs no warning", async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => warnings.push(message.text()));

    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.getAttribute("data-scroll-behavior"),
        ),
      )
      .toBe("smooth");

    // Any non-hash client navigation triggers the check in Next's router.
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .locator("#mobile-nav-panel")
      .getByRole("link", { name: "Contact", exact: true })
      .click();
    await expect(page).toHaveURL(/\/contact$/);
    // Give the post-navigation effects a tick to run before reading the log.
    await page.waitForTimeout(1000);

    expect(
      warnings.filter((text) => text.includes("scroll-behavior")),
      "the missing-data-scroll-behavior warning must not fire",
    ).toEqual([]);
  });
});

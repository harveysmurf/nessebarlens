import { expect, devices, test } from "@playwright/test";
import { PHOTOS } from "@/domain/catalog/photos";

/**
 * Mobile navigation (#331).
 *
 * Untagged, so it runs in the required `e2e-smoke` job with no secrets. It
 * exercises the real pages at phone widths: the root cause of the bug was the
 * header row overflowing `<body>` at every breakpoint below `md`, so the
 * acceptance criteria are asserted against the live layout, not the source.
 *
 * The print detail page uses a real catalog slug read from the compiled
 * catalog rather than a hardcoded one, matching smoke.spec.ts (#245).
 */
const CATALOG_SLUG = PHOTOS[0]!.slug;

/** Widths from the issue's acceptance criteria. */
const WIDTHS = [320, 375, 414] as const;

const PAGES = ["/", "/fine-art", "/archive", "/film", "/contact", `/prints/${CATALOG_SLUG}`] as const;

test.describe("mobile navigation (#331)", () => {
  // iPhone 13 is the reference mobile profile. `defaultBrowserType` is dropped
  // because `test.use` cannot force a new worker from inside a describe; the
  // loop below overrides the width to each acceptance-criteria value.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped, not used
  const { defaultBrowserType: _ignored, ...iphone13 } = devices["iPhone 13"];
  test.use(iphone13);

  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });

      for (const path of PAGES) {
        await page.goto(path);
        // A 1px tolerance absorbs sub-pixel rounding in the fixed header while
        // still catching the real bug: a row wider than the viewport.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(1);
      }
    });
  }

  test("below md the inline links are hidden and the toggle opens all four", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/");

    // The desktop inline nav is gone; the toggle is the only way in.
    const toggle = page.getByRole("button", { name: "Open menu" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // None of the inline links should be visible before opening.
    for (const label of ["Fine Art", "Archive", "Film Photography"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toBeHidden();
    }

    await toggle.click();
    const close = page.getByRole("button", { name: "Close menu" });
    await expect(close).toHaveAttribute("aria-expanded", "true");

    const panel = page.locator("#mobile-nav-panel");
    await expect(panel).toBeVisible();
    for (const label of ["Fine Art", "Archive", "Film Photography", "Contact"]) {
      await expect(panel.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // The active route keeps the desktop treatment on mobile.
    await panel.getByRole("link", { name: "Contact", exact: true }).click();
    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.locator("#mobile-nav-panel")).toBeHidden();
  });

  test("Escape closes the panel and returns focus to the toggle", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/");

    const toggle = page.getByRole("button", { name: "Open menu" });
    await toggle.click();
    await expect(page.locator("#mobile-nav-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#mobile-nav-panel")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });

  test("Tab is trapped inside the toggle and the panel while open", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/");

    await page.getByRole("button", { name: "Open menu" }).click();

    const close = page.getByRole("button", { name: "Close menu" });
    const panel = page.locator("#mobile-nav-panel");
    const first = panel.getByRole("link", { name: "Fine Art", exact: true });
    const last = panel.getByRole("link", { name: "Contact", exact: true });

    // Open moves focus to the first link.
    await expect(first).toBeFocused();

    // Backwards off the first link reaches the toggle, then wraps to the last.
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();

    // Forwards off the last link wraps back to the toggle rather than escaping
    // into the page content behind the overlay.
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
  });

  test("at md and up the desktop inline nav is unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Contact", exact: true })).toBeVisible();
  });

  test.describe("prefers-reduced-motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the panel animates not at all", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 844 });
      await page.goto("/");
      await page.getByRole("button", { name: "Open menu" }).click();

      const panel = page.locator("#mobile-nav-panel");
      await expect(panel).toBeVisible();

      // `.fade-in` is unlayered and would otherwise win over the layered
      // `motion-reduce:animate-none` utility; the unlayered globals.css
      // override is the only thing that can make this read "none" (#331 review).
      const animationName = await panel.evaluate(
        (el) => getComputedStyle(el).animationName,
      );
      expect(animationName).toBe("none");
    });
  });
});

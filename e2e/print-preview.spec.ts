import { expect, test, type Page } from "@playwright/test";
import { getPhoto } from "@/domain/catalog/photos";

/**
 * The product preview (#326): it shows, live, what Prodigi will print — the
 * fill crop, the frame moulding and mount, and the canvas front — for the
 * selected format, size and frame.
 *
 * These run against the dev server with the real compiled catalog, so they read
 * the two published photos' actual offers and masters. The bounding-box
 * assertions are geometric (window inside mount inside product), and a
 * screenshot of each kind is attached as a test artifact for review; there are
 * no pixel-diff assertions.
 */

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";
const GOLDEN =
  "golden-sun-flare-shining-through-stone-arch-ruins-of-saint-sophia-church-in-nessebar-bulgaria";

/**
 * The derivative ladder base the dev server is started with (playwright.config
 * `webServer.env`). The ladder is a real URL but the host is not resolvable, so
 * every image request is fulfilled with a small opaque image below — the point
 * is that the server resolved a ladder and the client rendered the `<img>`,
 * not the CDN.
 *
 * The image is 16x16, not 1x1. The `<img>` carries a `srcset` of width
 * descriptors and a `sizes` value, so Chromium reports `naturalWidth` as the
 * density-corrected intrinsic size: the selected rung (1500w) over `sizes`
 * (60vw at the test viewport) is a factor of ~2, and a 1x1 source rounds that
 * down to 0. A 16x16 source stays well clear of 0, so `naturalWidth > 0`
 * genuinely asserts the image decoded rather than the placeholder's size.
 */
const IMAGES_BASE = "https://images.e2e.test";

/** A 16x16 opaque PNG for the JPEG rungs. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGM8ISfHQApgIkn1qIZRDUNKAwBPHwEkcYw1mAAAAABJRU5ErkJggg==",
  "base64",
);

/** A 16x16 opaque WebP for the `<source type="image/webp">` rungs. */
const PIXEL_WEBP = Buffer.from(
  "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoQABAAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA",
  "base64",
);

function preview(page: Page) {
  return page.locator("[data-preview-kind]");
}

/**
 * The preview shows the server-resolved ladder image when the site has a
 * derivative base, and the alt text when it does not. CI builds the Worker
 * without `NEXT_PUBLIC_WEB_IMAGES_BASE`, so the no-image path is a real state:
 * assert whichever one the render is, not a specific one.
 */
async function expectPreviewImage(page: Page) {
  const img = preview(page).locator("img").first();
  if ((await img.count()) === 0) {
    await expect(preview(page).locator("span").first()).toBeVisible();
    return;
  }
  await expect
    .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth > 0))
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.route(`${IMAGES_BASE}/**`, (route) => {
    const webp = route.request().url().endsWith(".webp");
    return route.fulfill({
      status: 200,
      contentType: webp ? "image/webp" : "image/jpeg",
      body: webp ? PIXEL_WEBP : PIXEL_PNG,
    });
  });
});

test.describe("product preview (#326)", () => {
  test("opens on the photo's first offered format, uncropped for that kind", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const offer = getPhoto(HARBOUR)!.printOffer;
    const opening = offer.giclee.length > 0 ? "paper" : "framed";
    await expect(preview(page)).toHaveAttribute("data-preview-kind", opening);
    await expectPreviewImage(page);
  });

  test("framed shows the selected finish, and the label names it", async ({
    page,
  }, testInfo) => {
    await page.goto(`/prints/${HARBOUR}`);
    await page.getByText(/framed print/i).click();
    await page.locator("#frame-finish").selectOption("white");

    const box = preview(page);
    await expect(box).toHaveAttribute("data-preview-kind", "framed");
    await expect(box).toHaveAttribute("data-frame", "white");
    await expect(box).toHaveAttribute("aria-label", /Satin White/);
    await expectPreviewImage(page);

    const product = await box.boundingBox();
    const mount = await box.locator("[data-mount]").boundingBox();
    expect(product).not.toBeNull();
    expect(mount).not.toBeNull();

    await testInfo.attach("framed-white", {
      body: await box.screenshot(),
      contentType: "image/png",
    });
  });

  test("all three frame finishes render", async ({ page }, testInfo) => {
    await page.goto(`/prints/${HARBOUR}`);
    await page.getByText(/framed print/i).click();
    for (const finish of ["black", "white", "brown"] as const) {
      await page.locator("#frame-finish").selectOption(finish);
      const box = preview(page);
      await expect(box).toHaveAttribute("data-frame", finish);
      await testInfo.attach(`framed-${finish}`, {
        body: await box.screenshot(),
        contentType: "image/png",
      });
    }
  });

  test("changing size updates the preview and keeps the window inside the mount", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const offer = getPhoto(HARBOUR)!.printOffer;
    test.skip(offer.framed.length < 2, "needs two framed sizes to compare");
    await page.getByText(/framed print/i).click();
    await page.locator("#print-size").selectOption(offer.framed[1]!);

    const box = preview(page);
    await expect(box).toHaveAttribute("data-preview-kind", "framed");
    await expect(box).toHaveAttribute("data-size", offer.framed[1]!);

    const product = (await box.boundingBox())!;
    const mount = (await box.locator("[data-mount]").boundingBox())!;
    const window = (await box.locator("[data-window]").boundingBox())!;
    expect(window.x).toBeGreaterThanOrEqual(mount.x - 1);
    expect(window.y).toBeGreaterThanOrEqual(mount.y - 1);
    expect(window.x + window.width).toBeLessThanOrEqual(mount.x + mount.width + 1);
    expect(window.y + window.height).toBeLessThanOrEqual(mount.y + mount.height + 1);
    expect(mount.x).toBeGreaterThanOrEqual(product.x - 1);
    expect(mount.x + mount.width).toBeLessThanOrEqual(product.x + product.width + 1);
  });

  test("canvas shows the front only and notes the wrap", async ({
    page,
  }, testInfo) => {
    await page.goto(`/prints/${HARBOUR}`);
    await page.getByText(/stretched canvas/i).click();
    const box = preview(page);
    await expect(box).toHaveAttribute("data-preview-kind", "canvas");
    await expect(page.getByText(/wraps around the sides/i)).toBeVisible();
    await expectPreviewImage(page);
    await testInfo.attach("canvas", {
      body: await box.screenshot(),
      contentType: "image/png",
    });
  });

  test("digital shows the whole uncropped photo", async ({ page }, testInfo) => {
    await page.goto(`/prints/${HARBOUR}`);
    await page.getByText(/digital copy/i).click();
    const box = preview(page);
    await expect(box).toHaveAttribute("data-preview-kind", "digital");
    await expectPreviewImage(page);
    await testInfo.attach("digital", {
      body: await box.screenshot(),
      contentType: "image/png",
    });
  });

  test.describe("canvas angled view (#327)", () => {
    function toggle(page: Page) {
      return page.getByRole("radiogroup", { name: "Preview view" });
    }

    /** The stage shows alt text, not an image, when the site has no ladder base. */
    async function hasFrontImage(page: Page): Promise<boolean> {
      return (await preview(page).locator('[data-face="front"] img').count()) > 0;
    }

    async function expectAngled(page: Page) {
      await expect(preview(page)).toHaveAttribute("data-preview-view", "angled");
      if (!(await hasFrontImage(page))) {
        // The Worker build has no NEXT_PUBLIC_WEB_IMAGES_BASE, so there is no
        // resolved URL for the sides either; the front shows its alt text.
        await expect(preview(page).locator("span").first()).toBeVisible();
        return;
      }
      const right = preview(page).locator('[data-face="right"]').first();
      const box = await right.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      await expect
        .poll(() =>
          right
            .locator("img")
            .evaluate((node: HTMLImageElement) => node.naturalWidth > 0),
        )
        .toBe(true);
    }

    test("canvas opens angled with the photo wrapping onto the right side", async ({
      page,
    }, testInfo) => {
      await page.goto(`/prints/${HARBOUR}`);
      await page.getByText(/stretched canvas/i).click();
      await expectAngled(page);
      await testInfo.attach("canvas-angled-harbour", {
        body: await preview(page).screenshot(),
        contentType: "image/png",
      });
    });

    test("the second photo opens angled too", async ({ page }, testInfo) => {
      await page.goto(`/prints/${GOLDEN}`);
      await page.getByText(/stretched canvas/i).click();
      await expectAngled(page);
      await testInfo.attach("canvas-angled-golden", {
        body: await preview(page).screenshot(),
        contentType: "image/png",
      });
    });

    test("Front is the flat #326 view, and the toggle returns to angled", async ({
      page,
    }) => {
      await page.goto(`/prints/${HARBOUR}`);
      await page.getByText(/stretched canvas/i).click();
      await toggle(page).getByText("Front", { exact: true }).click();
      await expect(preview(page)).toHaveAttribute("data-preview-view", "front");
      const right = preview(page).locator('[data-face="right"]');
      if ((await right.count()) > 0) await expect(right).toBeHidden();

      await toggle(page).getByText("Angled", { exact: true }).click();
      await expect(preview(page)).toHaveAttribute("data-preview-view", "angled");
    });

    test("the toggle is canvas-only, and leaving canvas resets to angled", async ({
      page,
    }) => {
      await page.goto(`/prints/${HARBOUR}`);
      await page.getByText(/stretched canvas/i).click();
      await toggle(page).getByText("Front", { exact: true }).click();
      await expect(preview(page)).toHaveAttribute("data-preview-view", "front");

      await page.getByText(/framed print/i).click();
      await expect(toggle(page)).toHaveCount(0);

      await page.getByText(/stretched canvas/i).click();
      await expect(preview(page)).toHaveAttribute("data-preview-view", "angled");
    });

    test("switching views makes no additional image request", async ({ page }) => {
      const images: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith(IMAGES_BASE)) images.push(request.url());
      });
      await page.goto(`/prints/${HARBOUR}`);
      await page.getByText(/stretched canvas/i).click();
      const before = images.length;
      await toggle(page).getByText("Front", { exact: true }).click();
      await toggle(page).getByText("Angled", { exact: true }).click();
      await toggle(page).getByText("Front", { exact: true }).click();
      expect(images.length).toBe(before);
    });

    test("angled stays inside the stage at mobile width", async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(`/prints/${HARBOUR}`);
      await page.getByText(/stretched canvas/i).click();
      await expectAngled(page);
      const stage = await preview(page).boundingBox();
      const product = await preview(page).locator("[data-product]").boundingBox();
      expect(stage).not.toBeNull();
      expect(product).not.toBeNull();
      expect(product!.x).toBeGreaterThanOrEqual(stage!.x - 1);
      expect(product!.y).toBeGreaterThanOrEqual(stage!.y - 1);
      expect(product!.x + product!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
      expect(product!.y + product!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
    });
  });

  test("the landscape photo renders at mobile width", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/prints/${GOLDEN}`);
    await expect(preview(page)).toHaveAttribute("data-preview-kind", "paper");
    await expectPreviewImage(page);
    await testInfo.attach("paper-mobile", {
      body: await preview(page).screenshot(),
      contentType: "image/png",
    });
  });
});

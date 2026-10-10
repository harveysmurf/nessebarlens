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

function preview(page: Page) {
  return page.locator("[data-preview-kind]");
}

async function imageLoaded(page: Page): Promise<boolean> {
  const img = preview(page).locator("img").first();
  return img.evaluate((node: HTMLImageElement) => node.naturalWidth > 0);
}

test.describe("product preview (#326)", () => {
  test("opens on the photo's first offered format, uncropped for that kind", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const offer = getPhoto(HARBOUR)!.printOffer;
    const opening = offer.giclee.length > 0 ? "paper" : "framed";
    await expect(preview(page)).toHaveAttribute("data-preview-kind", opening);
    expect(await imageLoaded(page)).toBe(true);
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
    expect(await imageLoaded(page)).toBe(true);

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
    expect(await imageLoaded(page)).toBe(true);
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
    expect(await imageLoaded(page)).toBe(true);
    await testInfo.attach("digital", {
      body: await box.screenshot(),
      contentType: "image/png",
    });
  });

  test("the landscape photo renders at mobile width", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/prints/${GOLDEN}`);
    await expect(preview(page)).toHaveAttribute("data-preview-kind", "paper");
    expect(await imageLoaded(page)).toBe(true);
    await testInfo.attach("paper-mobile", {
      body: await preview(page).screenshot(),
      contentType: "image/png",
    });
  });
});

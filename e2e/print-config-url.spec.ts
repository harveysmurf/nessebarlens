import { expect, test, type Page } from "@playwright/test";
import { getPhoto } from "@/domain/catalog/photos";

/**
 * The print configuration lives in the URL (#333): a variation is shareable,
 * a shared link opens on it, and changing a control rewrites the query in place
 * with no navigation or reload.
 *
 * Runs against the dev server with the real compiled catalog, so the expected
 * values come from the two published photos' actual offers rather than a
 * fixture.
 */

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";
const GOLDEN =
  "golden-sun-flare-shining-through-stone-arch-ruins-of-saint-sophia-church-in-nessebar-bulgaria";

function query(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

function checkedFormat(page: Page) {
  return page.locator('input[name="print-format"]:checked').inputValue();
}

function preview(page: Page) {
  return page.locator("[data-preview-kind]");
}

test.describe("print configuration in the URL (#333)", () => {
  test("a shared URL opens on that exact variation", async ({ page }) => {
    const offer = getPhoto(GOLDEN)!.printOffer;
    const size = offer.framed[1]!;

    await page.goto(`/prints/${GOLDEN}?format=framed&size=${size}&frame=white`);

    await expect(
      page.locator('input[name="print-format"][value="framed"]'),
    ).toBeChecked();
    await expect(page.locator("#print-size")).toHaveValue(size);
    await expect(page.locator("#frame-finish")).toHaveValue("white");
    // The preview reflects the URL, not just the controls.
    await expect(preview(page)).toHaveAttribute("data-preview-kind", "framed");
    await expect(preview(page)).toHaveAttribute("data-frame", "white");
  });

  test("invalid params fall back to the default without error", async ({
    page,
  }) => {
    const offer = getPhoto(HARBOUR)!.printOffer;

    await page.goto(
      `/prints/${HARBOUR}?format=poster&size=999x999&frame=chartreuse`,
    );

    // The page still renders its product, not an error or a 404.
    await expect(page.locator("h1")).toBeVisible();
    await expect(
      page.locator('input[name="print-format"][value="giclee"]'),
    ).toBeChecked();
    await expect(page.locator("#print-size")).toHaveValue(offer.giclee[0]!);
    // Frame is not read for a giclée selection, so no control is shown for it.
    await expect(page.locator("#frame-finish")).toHaveCount(0);
    await expect(preview(page)).toHaveAttribute("data-preview-kind", "paper");
  });

  test("changing a control rewrites the URL in place", async ({ page }) => {
    const offer = getPhoto(HARBOUR)!.printOffer;
    await page.goto(`/prints/${HARBOUR}`);
    const historyBefore = await page.evaluate(() => history.length);

    await page.getByText(/framed print/i).click();
    await expect.poll(() => checkedFormat(page)).toBe("framed");
    await expect.poll(() => query(page).get("format")).toBe("framed");
    // Picking a physical format opens on its first offered size, and says so.
    await expect.poll(() => query(page).get("size")).toBe(offer.framed[0]);

    await page.locator("#print-size").selectOption(offer.framed[1]!);
    await expect.poll(() => query(page).get("size")).toBe(offer.framed[1]);

    await page.locator("#frame-finish").selectOption("white");
    await expect.poll(() => query(page).get("frame")).toBe("white");
    await expect(preview(page)).toHaveAttribute("data-frame", "white");

    // In place: `replaceState` leaves the history length untouched, so this was
    // not a navigation.
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  });

  test("a shared URL reproduces the selection on a fresh load, both photos", async ({
    page,
  }) => {
    for (const slug of [HARBOUR, GOLDEN]) {
      const size = getPhoto(slug)!.printOffer.canvas[1]!;
      await page.goto(`/prints/${slug}?format=canvas&size=${size}`);

      await expect(
        page.locator('input[name="print-format"][value="canvas"]'),
      ).toBeChecked();
      await expect(page.locator("#print-size")).toHaveValue(size);
      await expect(preview(page)).toHaveAttribute("data-preview-kind", "canvas");
    }
  });

  test("digital serialises with no size or frame", async ({ page }) => {
    await page.goto(`/prints/${HARBOUR}`);
    await page.getByText(/digital copy/i).click();

    // Only the format param survives: digital sells no size or frame.
    await expect.poll(() => query(page).toString()).toBe("format=digital");
    await expect(preview(page)).toHaveAttribute("data-preview-kind", "digital");
  });
});

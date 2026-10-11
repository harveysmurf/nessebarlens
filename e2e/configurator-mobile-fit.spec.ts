import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The configurator fits a narrow phone (#334, referencing #331).
 *
 * Framed size options are the longest strings in the configurator — the frame
 * size in cm, the SKU size in inches, and the visible image size behind the
 * mount — so this is where a copy change becomes a layout change.
 *
 * Two things this deliberately does NOT assert:
 *
 * - Page-level `scrollWidth <= innerWidth`. That is red on `main` for a
 *   different element entirely: the site header's nav is a non-wrapping flex
 *   row that runs past 320px. That belongs to #331, and gating this issue's
 *   copy PR on it would make the failure unreadable. The configurator is
 *   measured on its own below.
 *
 * - `select.scrollWidth > select.clientWidth`. Chromium does not report
 *   clipping on a native `<select>` — a label too long for the control is
 *   silently cut with no scrollWidth to detect it. So the label is measured as
 *   text against the control's content box, which is the thing that actually
 *   decides whether a buyer reads it.
 */

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";

/** The configurator panel, which is what this issue's copy can overflow. */
function configurator(page: Page): Locator {
  return page.locator("#print-size").locator("xpath=ancestor::div[contains(@class,'space-y-4')][1]");
}

/**
 * The widest pixel width the given strings need, in the select's own font, and
 * the width the select actually has for text. An `<option>` is not laid out, so
 * the text is measured in a throwaway span carrying the select's computed font.
 */
async function textBudget(
  select: Locator,
  texts: string[],
): Promise<{ needed: number; available: number; widest: string }> {
  return select.evaluate((el, texts) => {
    const cs = getComputedStyle(el);
    const available =
      el.clientWidth -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight);
    let needed = 0;
    let widest = "";
    for (const text of texts) {
      const probe = document.createElement("span");
      probe.style.cssText =
        `position:absolute;visibility:hidden;white-space:pre;` +
        `font:${cs.font};letter-spacing:${cs.letterSpacing}`;
      probe.textContent = text;
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      if (width > needed) {
        needed = width;
        widest = text;
      }
    }
    return { needed, available, widest };
  }, texts);
}

async function selectFramed(page: Page): Promise<void> {
  await page.goto(`/prints/${HARBOUR}`);
  await page.getByText(/framed print/i).first().click();
  // The finish select is framed-only, so it also proves the branch rendered.
  await expect(page.locator("#frame-finish")).toBeVisible();
}

for (const width of [320, 360]) {
  test.describe(`configurator at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 } });

    test("the configurator does not overflow the viewport", async ({ page }) => {
      await selectFramed(page);
      const box = await configurator(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    });

    test("every size option is readable, not clipped", async ({ page }) => {
      await selectFramed(page);
      const select = page.locator("#print-size");
      const options = await select
        .locator("option")
        .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));

      const { needed, available, widest } = await textBudget(select, options);
      expect(
        needed,
        `longest option "${widest}" needs ${Math.ceil(needed)}px, ` +
          `the select gives it ${available}px at ${width}px`,
      ).toBeLessThanOrEqual(available);
    });

    test("the mount note is readable and names the image size", async ({
      page,
    }) => {
      await selectFramed(page);
      const note = page.getByText(/snow-white acid-free mount/i);
      await expect(note).toBeVisible();

      // The note carries the size the select cannot fit (#334): it wraps, so
      // it is asserted to be inside the configurator rather than measured.
      const panel = (await configurator(page).boundingBox())!;
      const line = (await note.boundingBox())!;
      expect(line.x + line.width).toBeLessThanOrEqual(panel.x + panel.width);

      // And it actually names the photo's visible size. This is the whole
      // point of moving it off the size option, so asserting visibility alone
      // would pass even if the size were dropped from the string.
      await expect(note).toHaveText(/shows at \d+ × \d+ cm behind the mount/);
    });
  });
}
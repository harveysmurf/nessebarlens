import { expect, test, type Page } from "@playwright/test";
import { getPhoto } from "@/domain/catalog/photos";
import { sizeLabel } from "@/domain/pricing/pricing";

/**
 * The print configurator renders a photo's committed print offer (#302): only
 * the formats and sizes that photo is sold at, labelled in its orientation.
 *
 * These run against the dev server with the real compiled catalog, so they read
 * the two published photos' actual offers rather than a fixture. The physical
 * quote needs the Prodigi sandbox and is skipped without a key; the digital flow
 * that proves a purchase still completes is the `@hosted` smoke flow in
 * e2e/smoke.spec.ts, which this spec does not duplicate.
 */

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";
const GOLDEN =
  "golden-sun-flare-shining-through-stone-arch-ruins-of-saint-sophia-church-in-nessebar-bulgaria";

const PHYSICAL = ["giclee", "framed", "canvas"] as const;

async function sizeValues(page: Page): Promise<string[]> {
  return page
    .locator("#print-size option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
}

async function sizeLabels(page: Page): Promise<string[]> {
  return page
    .locator("#print-size option")
    .evaluateAll((opts) => opts.map((o) => (o.textContent ?? "").trim()));
}

test.describe("print configurator shows only the photo's offer (#302)", () => {
  test("the harbour size select matches its committed offer exactly", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const offer = getPhoto(HARBOUR)!.printOffer;

    // Opens on the first offered format (giclée) and its first offered size.
    await expect(page.locator("#print-size")).toBeVisible();
    expect(await sizeValues(page)).toEqual([...offer.giclee]);

    await page.getByText(/framed print/i).click();
    expect(await sizeValues(page)).toEqual([...offer.framed]);

    await page.getByText(/stretched canvas/i).click();
    expect(await sizeValues(page)).toEqual([...offer.canvas]);
  });

  test("a landscape photo labels sizes long edge first, from the offer", async ({
    page,
  }) => {
    await page.goto(`/prints/${GOLDEN}`);
    const photo = getPhoto(GOLDEN)!;
    expect(photo.master.orientation).toBe("landscape");

    // giclée is the default format; only its offered sizes are listed.
    expect(await sizeValues(page)).toEqual([...photo.printOffer.giclee]);
    // A size the offer excludes (70×100, below the PPI floor) is not present.
    expect(await sizeValues(page)).not.toContain("70x100");
    // Landscape: the long edge reads first; the value stays short edge first.
    expect(await sizeLabels(page)).toEqual(
      photo.printOffer.giclee.map((size) => sizeLabel(size, "landscape")),
    );
    // The smallest offered size is a #303 2:3 size, and reads long edge first.
    expect((await sizeLabels(page))[0]).toBe('30 × 20 cm (12 × 8")');
  });

  test("only offered formats are buttons, and digital is always one", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const offer = getPhoto(HARBOUR)!.printOffer;
    const shown = await page
      .locator('input[name="print-format"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value));
    const expected: string[] = [
      ...PHYSICAL.filter((f) => offer[f].length > 0),
      "digital",
    ];
    expect(shown).toEqual(expected);
  });

  test("digital is offered and prices itself with no quote", async ({ page }) => {
    await page.goto(`/prints/${HARBOUR}`);
    // Every published photo offers digital, whatever its physical offer.
    await page.getByText(/digital copy/i).click();
    await expect(page.getByText(/€30\.00/).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /checkout with stripe/i }),
    ).toBeEnabled();
  });
});

const sandboxProdigiKey = process.env.PRODIGI_SANDBOX_API_KEY?.trim();

test.describe("@hosted physical quote from the offer", () => {
  test.skip(
    !sandboxProdigiKey,
    "no PRODIGI_SANDBOX_API_KEY configured — Prodigi is stubbed or sandbox, never a live account",
  );

  test("choosing an offered physical size produces a live quote", async ({
    page,
  }) => {
    await page.goto(`/prints/${HARBOUR}`);
    const checkout = page.getByRole("button", {
      name: /checkout with stripe/i,
    });
    await expect(checkout).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText(/shipping estimate/i)).toBeVisible();
  });

  test("a new 2:3 size quotes and reaches Stripe (#303)", async ({ page }) => {
    // Golden sun offers giclée 40×60 — one of the #303 2:3 sizes. Picking it
    // proves the new size flows through /api/quote (the real table SKU) and on
    // to the Stripe redirect, not just that it renders.
    await page.goto(`/prints/${GOLDEN}`);
    await page.locator("#print-size").selectOption("40x60");
    const checkout = page.getByRole("button", {
      name: /checkout with stripe/i,
    });
    await expect(checkout).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText(/shipping estimate/i)).toBeVisible();
    await Promise.all([
      page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 }),
      checkout.click(),
    ]);
  });
});

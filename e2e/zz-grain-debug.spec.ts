import { test, type Page } from "@playwright/test";

const HARBOUR = "nessebar-harbour-in-black-and-white-bulgaria";
const IMAGES_BASE = "https://images.e2e.test";
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGM8ISfHQApgIkn1qIZRDUNKAwBPHwEkcYw1mAAAAABJRU5ErkJggg==",
  "base64",
);
const PIXEL_WEBP = Buffer.from(
  "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoQABAAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA",
  "base64",
);

function preview(page: Page) {
  return page.locator("[data-preview-kind]");
}

async function probe(page: Page, selector: string) {
  const shot = await page.locator(selector).screenshot();
  return {
    png: shot,
    stats: await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lum = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      };
      const margin = Math.max(2, Math.floor(Math.min(width, height) * 0.1));
      let sum = 0;
      let n = 0;
      const rowSums: number[] = [];
      for (let y = margin; y < height - margin; y++) {
        let rs = 0;
        let rn = 0;
        for (let x = margin; x < width - margin; x++) {
          const c = lum(x, y);
          const v = Math.max(
            Math.abs(lum(x - 1, y) + lum(x + 1, y) - 2 * c),
            Math.abs(lum(x, y - 1) + lum(x, y + 1) - 2 * c),
          );
          rs += v;
          rn++;
        }
        rowSums.push(rn === 0 ? 0 : rs / rn);
        sum += rs;
        n += rn;
      }
      return { width, height, margin, n, mean: n === 0 ? 0 : sum / n, rowSums };
    }, shot.toString("base64")),
  };
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

test("grain debug", async ({ page }, testInfo) => {
  await page.goto(`/prints/${HARBOUR}`);
  await page.getByText(/framed print/i).click();
  const spikes: string[] = [];
  for (let round = 0; round < 6; round++) {
    for (const finish of ["black", "white", "brown"] as const) {
      await page.locator("#frame-finish").selectOption(finish);
      await preview(page).getAttribute("data-frame");
      const { png, stats } = await probe(page, `[data-frame="${finish}"] [data-moulding="top"]`);
      console.log(
        `GRAIN round=${round} finish=${finish} w=${stats.width} h=${stats.height} m=${stats.margin} n=${stats.n} mean=${stats.mean.toFixed(6)} rowSums=[${stats.rowSums.map((v) => v.toFixed(2)).join(",")}]`,
      );
      if (stats.mean > 5 && finish !== "brown") {
        spikes.push(`${finish}@r${round}=${stats.mean.toFixed(3)}`);
        await testInfo.attach(`SPIKE-${round}-${finish}`, { body: png, contentType: "image/png" });
      }
      if (round < 2) {
        await testInfo.attach(`raw-${round}-${finish}`, { body: png, contentType: "image/png" });
      }
    }
  }
  if (spikes.length > 0) throw new Error(`grain spikes: ${spikes.join(", ")}`);
});

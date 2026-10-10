import { expect, test } from "@playwright/test";
import { PHOTOS } from "@/domain/catalog/photos";

/**
 * /api/checkout enforces the photo's committed print offer (#301): a spec the
 * offer does not include is refused with 400 before any Prodigi or Stripe call.
 *
 * This drives the route directly via request.post, so it runs on the bare dev
 * server with no Prodigi key — the 400 fires before the quote gateway is ever
 * reached. That makes it gate-grade, same as #302's configurator spec.
 */

const CATALOG_SLUG = PHOTOS[0]!.slug;

test.describe("checkout offer enforcement (#301)", () => {
  test("a non-offered physical size is a 400 before any gateway call", async ({
    request,
  }) => {
    // The golden photo's committed offer lists giclee 30x40 and 50x70 but not
    // 70x100 (below the PPI floor). 70x100 exists in the table, so this
    // exercises offers() returning false rather than a parse error.
    const res = await request.post("/api/checkout", {
      data: {
        photoSlug: CATALOG_SLUG,
        format: "giclee",
        size: "70x100",
        frame: null,
        destinationCountryCode: "BG",
      },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toHaveProperty(
      "error",
      "This print option is not available for this photo",
    );
  });

  test("a digital spec passes the offer gate and is never refused as non-offered", async ({
    request,
  }) => {
    // Digital is always offered: the gate must never reject it with 400. The
    // dev server carries a Stripe placeholder key, so the request reaches Stripe
    // and returns 502 — the assertion is that it is never the offer-gate 400.
    const res = await request.post("/api/checkout", {
      data: { photoSlug: CATALOG_SLUG, format: "digital" },
    });
    expect(res.status()).not.toBe(400);
    expect(await res.json()).not.toHaveProperty(
      "error",
      "This print option is not available for this photo",
    );
  });
});

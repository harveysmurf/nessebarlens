/**
 * Prodigi does not rotate a landscape asset to the SKU's orientation (#298).
 *
 * The spike placed sandbox orders with a landscape 3:2 asset and read the
 * dashboard preview: the photo is centre-cropped to the portrait print area,
 * not turned. This is the sandbox-gated acceptance test for that flow — it
 * signs a real `/api/print-asset` URL for a landscape master, creates the
 * `GLOBAL-FAP-12X16` order through the real `buildProdigiOrderBody` + Prodigi
 * client, asserts Prodigi accepts and downloads the asset, then cancels with
 * the existing cancel client.
 *
 * It is skipped without a sandbox key, an https origin and the print-asset
 * HMAC secret, because it leaves the process: the Worker must be able to sign
 * and serve the master. Rotation itself is not assertable from the v4 API (it
 * exposes only a thumbnail of the uploaded asset), so the orientation fix is
 * tracked in #307 and this test pins the accepted-order half.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PHOTOS } from "../src/domain/catalog/photos.ts";
import type { OrderRecipient } from "../src/domain/ordering/order-recipient.ts";
import { signPrintAssetUrl } from "../src/application/fulfillment/print-asset.ts";
import { ConfiguredAssetUrlSigner } from "../src/infrastructure/print-asset/asset-url-signer.ts";
import { createProdigiOrder } from "../src/infrastructure/prodigi/prodigi-order.ts";
import { cancelProdigiOrder } from "../src/infrastructure/prodigi/prodigi-cancel.ts";
import { PRODIGI_SANDBOX_API_BASE } from "../src/infrastructure/prodigi/prodigi-config.ts";

const sandboxKey = process.env.PRODIGI_SANDBOX_API_KEY?.trim();
const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
const hmacSecret = process.env.PRINT_ASSET_HMAC_SECRET?.trim();
const hasEnv = Boolean(
  sandboxKey && site?.startsWith("https://") && hmacSecret,
);
const skipReason =
  "needs PRODIGI_SANDBOX_API_KEY, an https NEXT_PUBLIC_SITE_URL and PRINT_ASSET_HMAC_SECRET";

const RECIPIENT: OrderRecipient = {
  name: "Rotation Spike",
  line1: "1 Test Street",
  line2: "",
  city: "London",
  state: "",
  postcode: "EC1A 1AA",
  countryCode: "GB",
  email: "spike@example.com",
  phone: null,
};

type OrderState = { itemStatus: string; downloadAssets: string; issues: unknown[] };

async function readOrderState(orderId: string): Promise<OrderState> {
  const res = await fetch(
    `${PRODIGI_SANDBOX_API_BASE}/v4.0/orders/${orderId}`,
    { headers: { "X-API-Key": sandboxKey! } },
  );
  const body = (await res.json()) as {
    order?: {
      status?: { details?: { downloadAssets?: string }; issues?: unknown[] };
      items?: Array<{ status?: string }>;
    };
  };
  return {
    itemStatus: body.order?.items?.[0]?.status ?? "unknown",
    downloadAssets: body.order?.status?.details?.downloadAssets ?? "unknown",
    issues: body.order?.status?.issues ?? [],
  };
}

/** Poll until Prodigi has downloaded the asset, or the deadline passes. */
async function waitForAsset(orderId: string, timeoutMs = 90_000): Promise<OrderState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readOrderState(orderId);
  while (Date.now() < deadline && state.downloadAssets !== "Complete") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    state = await readOrderState(orderId);
  }
  return state;
}

test(
  "a landscape master is accepted as a portrait FAP-12X16 sandbox order",
  { skip: hasEnv ? false : skipReason },
  async () => {
    process.env.PRODIGI_API_BASE = PRODIGI_SANDBOX_API_BASE;

    // A landscape master, so the order exercises the case Prodigi crops.
    const landscape =
      PHOTOS.find((photo) => photo.master?.orientation === "landscape") ??
      PHOTOS[0]!;
    const signer = new ConfiguredAssetUrlSigner();
    const assetUrl = await signPrintAssetUrl(landscape.slug, signer);
    assert.ok(assetUrl, `could not sign a print-asset URL for ${landscape.slug}`);

    const sessionId = `cs_test_298_${Date.now().toString(36)}`;
    const created = await createProdigiOrder({
      sessionId,
      photoSlug: landscape.slug,
      format: "giclee",
      size: "30x40",
      frame: null,
      recipient: RECIPIENT,
      assetUrl,
      assetMd5: "c".repeat(32),
    });
    assert.equal(created.ok, true, created.ok ? "" : created.message);
    if (!created.ok) return;

    const orderId = created.value.orderId;
    try {
      const state = await waitForAsset(orderId);
      assert.deepEqual(state.issues, [], "Prodigi reported issues for the order");
      assert.equal(
        state.downloadAssets,
        "Complete",
        `asset not downloaded after the deadline (item ${state.itemStatus})`,
      );
      assert.notEqual(state.itemStatus, "Error");
    } finally {
      // Best-effort by design: assert the call returns a result, never throws.
      const cancelled = await cancelProdigiOrder({ prodigiOrderId: orderId, sessionId });
      assert.ok(
        cancelled.ok === true || typeof cancelled.reason === "string",
        "cancel must return a result, not throw",
      );
    }
  },
);

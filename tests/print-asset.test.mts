import assert from "node:assert/strict";
import test from "node:test";
import {
  PRINT_ASSET_SECRET_MIN_LENGTH,
  PRINT_ASSET_TTL_SECONDS,
  printAssetSecret,
  resolvePrintAssetStream,
  signPrintAssetUrl,
  verifyPrintAssetRequest,
} from "../src/lib/print-asset.ts";
import { readWorkerBindings } from "../src/lib/worker-bindings.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
  resolveOrderAssetUrl,
  type OrderRecipient,
} from "../src/lib/prodigi-order.ts";

const SECRET = "test-print-asset-hmac-secret-32b-min!!";
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");

const RECIPIENT: OrderRecipient = {
  name: "Test Buyer",
  line1: "1 Harbor St",
  line2: "",
  city: "Nessebar",
  state: "",
  postcode: "8230",
  countryCode: "BG",
  email: "buyer@example.com",
  phone: null,
};

test("printAssetSecret requires 32+ chars", () => {
  assert.equal(printAssetSecret({ PRINT_ASSET_HMAC_SECRET: "short" }), null);
  assert.equal(printAssetSecret({ PRINT_ASSET_HMAC_SECRET: SECRET }), SECRET);
});

test("printAssetSecret boundary is exactly PRINT_ASSET_SECRET_MIN_LENGTH", () => {
  const exact = "x".repeat(PRINT_ASSET_SECRET_MIN_LENGTH);
  assert.equal(printAssetSecret({ PRINT_ASSET_HMAC_SECRET: exact }), exact);
  assert.equal(
    printAssetSecret({ PRINT_ASSET_HMAC_SECRET: "x".repeat(PRINT_ASSET_SECRET_MIN_LENGTH - 1) }),
    null,
  );
});

test("readWorkerBindings and printAssetSecret never disagree", async () => {
  const saved = process.env.PRINT_ASSET_HMAC_SECRET;
  try {
    for (const raw of [undefined, "short", "x".repeat(31), SECRET, `  ${SECRET}  `]) {
      if (raw === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
      else process.env.PRINT_ASSET_HMAC_SECRET = raw;
      const bindings = await readWorkerBindings();
      assert.equal(
        bindings.printAssetSecret ?? null,
        printAssetSecret(),
        `drift for ${JSON.stringify(raw)}`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.PRINT_ASSET_HMAC_SECRET;
    else process.env.PRINT_ASSET_HMAC_SECRET = saved;
  }
});

test("sign + verify round-trip; expiry and bad sig fail", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const url = await signPrintAssetUrl("dawn", {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.ok(url);
  assert.match(url!, /^https:\/\/nessebarlens\.com\/api\/print-asset\?/);
  assert.equal(url!.includes("prints/"), false);
  assert.equal(url!.includes("masters"), false);

  const parsed = new URL(url!);
  const slug = parsed.searchParams.get("slug")!;
  const exp = parsed.searchParams.get("exp")!;
  const sig = parsed.searchParams.get("sig")!;

  const ok = await verifyPrintAssetRequest(slug, exp, sig, {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.deepEqual(ok, { ok: true, slug: "dawn" });

  const expired = await verifyPrintAssetRequest(slug, exp, sig, {
    secret: SECRET,
    nowMs: NOW_MS + (PRINT_ASSET_TTL_SECONDS + 1) * 1000,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error, "expired");

  const bad = await verifyPrintAssetRequest(slug, exp, "0".repeat(64), {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "bad-signature");
});

test("signed URL has no .jpg extension (Prodigi tolerance unknown; content-type is jpeg)", async () => {
  const url = await signPrintAssetUrl("dawn", {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.ok(url);
  const path = new URL(url!).pathname;
  assert.equal(path.endsWith(".jpg"), false);
  assert.equal(path, "/api/print-asset");
});

test("sign returns null without secret; resolveOrderAssetUrl falls back to placeholder", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  assert.equal(await signPrintAssetUrl("dawn", { secret: null }), null);
  assert.equal(
    await resolveOrderAssetUrl("dawn"),
    "https://nessebarlens.com/placeholders/dawn.jpg",
  );
});

test("Prodigi body accepts HMAC print-asset URL without master leak", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const assetUrl = (await signPrintAssetUrl("dawn", {
    secret: SECRET,
    nowMs: NOW_MS,
  }))!;
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: "dawn",
    format: "giclee",
    size: "50x70",
    frame: null,
    recipient: RECIPIENT,
    assetUrl,
  });
  assert.equal(body.items[0].assets[0].url, assetUrl);
  assertNoMasterLeak(body);
});

test("resolvePrintAssetStream serves catalog master only", async () => {
  const chunks: Uint8Array[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode("jpeg-bytes");
      chunks.push(bytes);
      controller.enqueue(bytes);
      controller.close();
    },
  });
  let gotKey: string | null = null;
  const masters = {
    async get(key: string) {
      gotKey = key;
      return { body, size: 10, contentType: "image/jpeg" };
    },
  };
  const resolved = await resolvePrintAssetStream("dawn", masters);
  assert.equal(gotKey, "prints/dawn.jpg");
  assert.equal(resolved.kind, "stream");
  if (resolved.kind === "stream") {
    assert.equal(resolved.contentType, "image/jpeg");
    assert.equal(resolved.size, 10);
  }

  const missing = await resolvePrintAssetStream("not-a-photo", masters);
  assert.equal(missing.kind, "json");
  if (missing.kind === "json") assert.equal(missing.status, 400);
});

test("a caller-supplied baseUrl with extra slashes yields a single-slash URL", async () => {
  // The old inline strip removed one trailing slash only, so a base ending
  // "//" produced "…//api/print-asset?…" and the signature check in the
  // Worker compared against a differently-shaped path.
  for (const baseUrl of ["https://x.test", "https://x.test/", "https://x.test//"]) {
    const url = await signPrintAssetUrl("dawn", {
      secret: SECRET,
      nowMs: NOW_MS,
      baseUrl,
    });
    assert.ok(url, baseUrl);
    assert.equal(url.startsWith("https://x.test/api/print-asset?"), true, url);
  }
});

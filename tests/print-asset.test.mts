import assert from "node:assert/strict";
import test from "node:test";
import {
  canSignMasterAsset,
  resolvePrintAssetStream,
  signPrintAssetUrl,
  verifyPrintAssetRequest,
} from "../src/application/fulfillment/print-asset.ts";
import { PRINT_ASSET_TTL_SECONDS } from "../src/domain/ordering/asset-url-signer.ts";
import { ConfiguredAssetUrlSigner } from "../src/infrastructure/print-asset/asset-url-signer.ts";
import { printAssetSecret } from "../src/infrastructure/config/config.ts";
import { PRINT_ASSET_SECRET_MIN_LENGTH } from "../src/domain/ordering/print-asset.ts";
import { readWorkerBindings } from "../src/infrastructure/cloudflare/worker-bindings.ts";
import {
  assertNoMasterLeak,
  buildProdigiOrderBody,
} from "../src/infrastructure/prodigi/prodigi-order.ts";
import type { OrderRecipient } from "../src/domain/ordering/order-recipient.ts";
import { hmacSha256Hex } from "../src/domain/pricing/crypto-hex.ts";
import {
  SAMPLE_MASTER_KEY,
  SAMPLE_PRINT_ASSET_KEY,
  SAMPLE_SLUG,
} from "./fixtures/sample-photo.mts";

const SECRET = "test-print-asset-hmac-secret-32b-min!!";
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
const SIGNER = new ConfiguredAssetUrlSigner();

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
  const url = await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, {
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

  const ok = await verifyPrintAssetRequest(slug, exp, sig, SIGNER, {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.deepEqual(ok, { ok: true, slug: SAMPLE_SLUG });

  const expired = await verifyPrintAssetRequest(slug, exp, sig, SIGNER, {
    secret: SECRET,
    nowMs: NOW_MS + (PRINT_ASSET_TTL_SECONDS + 1) * 1000,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error, "expired");

  const bad = await verifyPrintAssetRequest(slug, exp, "0".repeat(64), SIGNER, {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "bad-signature");
});

test("signed URL has no .jpg extension (Prodigi tolerance unknown; content-type is jpeg)", async () => {
  const url = await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, {
    secret: SECRET,
    nowMs: NOW_MS,
  });
  assert.ok(url);
  const path = new URL(url!).pathname;
  assert.equal(path.endsWith(".jpg"), false);
  assert.equal(path, "/api/print-asset");
});

test("signer and verifier resolve the configured secret identically", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  // A binding-pasted secret with surrounding whitespace: both paths must trim
  // it, and must agree, or the signer signs with one key and the verifier
  // checks another.
  process.env.PRINT_ASSET_HMAC_SECRET = `  ${SECRET}  `;
  const nowMs = 1_700_000_000_000;
  const url = (await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, { nowMs }))!;
  assert.ok(url, "configured secret must produce a signature");
  const query = new URL(url).searchParams;
  const verified = await verifyPrintAssetRequest(SAMPLE_SLUG, query.get("exp")!, query.get("sig")!, SIGNER, {
    nowMs,
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));

  // A whitespace-only secret is unusable on both sides, identically.
  process.env.PRINT_ASSET_HMAC_SECRET = " ".repeat(32);
  assert.equal(await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, { nowMs }), null);
  assert.deepEqual(
    await verifyPrintAssetRequest(SAMPLE_SLUG, query.get("exp")!, query.get("sig")!, SIGNER, { nowMs }),
    { ok: false, status: 503, error: "print-asset-unavailable" },
  );
  delete process.env.PRINT_ASSET_HMAC_SECRET;
});

test("sign returns null without secret, and the order asset path has no placeholder left", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  delete process.env.PRINT_ASSET_HMAC_SECRET;
  assert.equal(await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, { secret: null }), null);
  // Null, not a fallback: a paid order must never be fulfilled from the public
  // low-res stand-in. The caller turns this into a retryable failure.
  assert.equal(await signPrintAssetUrl(SAMPLE_SLUG, SIGNER), null);
});

test("Prodigi body accepts HMAC print-asset URL without master leak", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const assetUrl = (await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, {
    secret: SECRET,
    nowMs: NOW_MS,
  }))!;
  const body = buildProdigiOrderBody({
    sessionId: "cs_test_abcdefgh",
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "50x70",
    frame: null,
    recipient: RECIPIENT,
    assetUrl,
    assetMd5: "c".repeat(32),
  });
  assert.equal(body.items[0].assets[0].url, assetUrl);
  // #307: the md5 travels with the URL so Prodigi verifies the fetched bytes.
  assert.equal(body.items[0].assets[0].md5Hash, "c".repeat(32));
  assertNoMasterLeak(body);
});

test("canSignMasterAsset refuses a slug the catalog has no print asset for (#307 PR 2)", async () => {
  // The pre-payment guard's catalog half: a well-formed slug with no catalog
  // print asset is refused before signing, so checkout cannot take money for a
  // physical order it could only fulfil from the unrotated master.
  assert.equal(await canSignMasterAsset("not-a-photo", SIGNER), false);
});

test("resolvePrintAssetStream serves the catalog print asset only (#307)", async () => {
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
      // A PNG master's metadata is deliberately not honoured here: Prodigi is
      // documented to want a JPEG, so the header is forced, not inherited.
      return {
        body,
        size: 10,
        httpMetadata: { contentType: "image/png" },
      };
    },
  };
  const resolved = await resolvePrintAssetStream(SAMPLE_SLUG, masters);
  // The print asset, never the master: `prints/{slug}.jpg` would be the
  // unrotated file #307 exists to keep away from Prodigi.
  assert.equal(gotKey, SAMPLE_PRINT_ASSET_KEY);
  assert.notEqual(gotKey, SAMPLE_MASTER_KEY);
  assert.equal(resolved.kind, "stream");
  if (resolved.kind === "stream") {
    assert.equal(resolved.contentType, "image/jpeg");
    assert.equal(resolved.size, 10);
  }

  // Invalid grammar is a 400 (a caller bug), distinct from a valid slug with
  // no catalog print asset, which is the retryable 503.
  const missing = await resolvePrintAssetStream("Not A Slug", masters);
  assert.equal(missing.kind, "json");
  if (missing.kind === "json") assert.equal(missing.status, 400);
});

test("a caller-supplied baseUrl with extra slashes yields a single-slash URL", async () => {
  // The old inline strip removed one trailing slash only, so a base ending
  // "//" produced "…//api/print-asset?…" and the signature check in the
  // Worker compared against a differently-shaped path.
  for (const baseUrl of ["https://x.test", "https://x.test/", "https://x.test//"]) {
    const url = await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, {
      secret: SECRET,
      nowMs: NOW_MS,
      baseUrl,
    });
    assert.ok(url, baseUrl);
    assert.equal(url.startsWith("https://x.test/api/print-asset?"), true, url);
  }
});

test("verifyPrintAssetRequest fails closed at every boundary, in order", async () => {
  const nowMs = NOW_MS;
  const exp = Math.floor(nowMs / 1000) + 60;
  const signed = await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, { secret: SECRET, nowMs, ttlSeconds: 60 });
  assert.ok(signed);
  const sig = new URL(signed).searchParams.get("sig")!;

  // No secret: nothing is verifiable, so 503 before any parsing.
  assert.deepEqual(await verifyPrintAssetRequest(SAMPLE_SLUG, String(exp), sig, SIGNER, { secret: null, nowMs }), {
    ok: false,
    status: 503,
    error: "print-asset-unavailable",
  });

  const bad = async (
    slug: string,
    expRaw: string,
    signature: string,
    error: string,
    status: number,
  ) => {
    const result = await verifyPrintAssetRequest(slug, expRaw, signature, SIGNER, { secret: SECRET, nowMs });
    const actual = result.ok
      ? `ok:true (${JSON.stringify(result)})`
      : `${result.status} ${result.error}`;
    assert.equal(
      actual,
      `${status} ${error}`,
      `slug=${slug} exp=${expRaw} sig=${signature.slice(0, 8)}…`,
    );
  };
  await bad("not-a-photo", String(exp), sig, "invalid-slug", 400);
  await bad(SAMPLE_SLUG, `${exp}.5`, sig, "invalid-exp", 400);
  await bad(SAMPLE_SLUG, "notanumber", sig, "invalid-exp", 400);
  await bad(SAMPLE_SLUG, "9".repeat(13), sig, "invalid-exp", 400);
  await bad(SAMPLE_SLUG, String(exp), "zz".repeat(32), "invalid-sig", 400);
  await bad(SAMPLE_SLUG, String(exp), sig.slice(0, 63), "invalid-sig", 400);
  // A wrong but well-formed signature is a 401, not a 400.
  await bad(SAMPLE_SLUG, String(exp), "ab".repeat(32), "bad-signature", 401);

  // Expired and absurdly-future expiries are distinguished.
  // Signed 10s in the past with a 1s TTL, so exp is genuinely behind now.
  const expired = await signPrintAssetUrl(SAMPLE_SLUG, SIGNER, { secret: SECRET, nowMs: nowMs - 10_000, ttlSeconds: 1 });
  const expiredSig = new URL(expired!).searchParams.get("sig")!;
  const expiredExp = new URL(expired!).searchParams.get("exp")!;
  await bad(SAMPLE_SLUG, expiredExp, expiredSig, "expired", 401);
  // The window is TTL + 300s (7 days), so "absurd" means past that, not past
  // an hour. 8 days out is rejected before the signature is even compared.
  const eightDays = Math.floor(nowMs / 1000) + 8 * 24 * 60 * 60;
  await bad(SAMPLE_SLUG, String(eightDays), sig, "invalid-exp", 400);
  // One second inside the window is a signature problem, not an exp problem.
  await bad(SAMPLE_SLUG, String(Math.floor(nowMs / 1000) + 7 * 24 * 60 * 60 + 299), sig, "bad-signature", 401);

  // A signature for a different slug must not verify for this one. There is
  // only one catalog slug, so the second payload is computed from the signing
  // grammar (`v1.{slug}.{exp}`) rather than signed for a second photo.
  const otherSig = await hmacSha256Hex(`v1.other-slug.${exp}`, SECRET);
  await bad(SAMPLE_SLUG, String(exp), otherSig, "bad-signature", 401);

  // And the happy path still passes.
  const ok = await verifyPrintAssetRequest(SAMPLE_SLUG, String(exp), sig, SIGNER, { secret: SECRET, nowMs });
  assert.deepEqual(ok, { ok: true, slug: SAMPLE_SLUG });
});

test("resolvePrintAssetStream separates missing binding, bucket error and missing object", async () => {
  const bytes = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff]));
        controller.close();
      },
    });

  // A slug that fails the grammar never reaches the bucket: 400.
  const unknown = await resolvePrintAssetStream("Not A Slug", { get: async () => null });
  assert.equal(unknown.kind === "json" && unknown.status, 400);

  // No MASTERS binding at all is 503, not a crash.
  const unbound = await resolvePrintAssetStream(SAMPLE_SLUG, undefined);
  assert.equal(unbound.kind === "json" && unbound.status, 503);
  assert.equal(unbound.kind === "json" && unbound.body.error, "masters-unavailable");

  // A throwing bucket is the same 503 as an absent one, and must not escape.
  const throwing = await resolvePrintAssetStream(SAMPLE_SLUG, {
    get: async () => {
      throw new Error("R2 unavailable");
    },
  });
  assert.equal(throwing.kind === "json" && throwing.status, 503);

  // A missing object is now the same retryable 503 as a missing catalog key:
  // the print asset is not there, so Prodigi must retry — never fall back to
  // the unrotated master (#307).
  const missing = await resolvePrintAssetStream(SAMPLE_SLUG, { get: async () => null });
  assert.equal(missing.kind === "json" && missing.status, 503);
  assert.equal(missing.kind === "json" && missing.body.error, "print-asset-unavailable");

  // The happy path streams the catalog print-asset key, not a caller-supplied
  // one and not the master.
  const keys: string[] = [];
  const found = await resolvePrintAssetStream(SAMPLE_SLUG, {
    get: async (key: string) => {
      keys.push(key);
      return { body: bytes(), size: 3 };
    },
  });
  assert.deepEqual(keys, [SAMPLE_PRINT_ASSET_KEY]);
  assert.equal(found.kind === "stream", true);
  assert.equal(found.kind === "stream" && found.contentType, "image/jpeg");
  assert.equal(found.kind === "stream" && found.size, 3);
});

test("the stream's only gate: grammar is a 400, a non-catalog slug a retryable 503, no bucket read", async () => {
  // Invalid grammar is a caller bug: 400, so Prodigi does not retry a request
  // that can never succeed. A well-formed slug with no catalog photo (or none
  // with a print asset) is a retryable 503 — and crucially the bucket is never
  // asked for the master key, which is the fallback #307 removes.
  let called = 0;
  const bucket = {
    async get() {
      called++;
      return { body: new ReadableStream(), size: 1 };
    },
  };
  for (const slug of ["", "Dawn", "dawn.jpg", "../prints/dawn.jpg", "prints/dawn.jpg", "co%2Fb"]) {
    const result = await resolvePrintAssetStream(slug, bucket);
    assert.equal(result.kind === "json", true, slug);
    assert.equal(result.kind === "json" && result.status, 400, slug);
    assert.equal(result.kind === "json" && result.body.error, "invalid-slug", slug);
  }
  for (const slug of ["not-a-photo", "winter-pier"]) {
    const result = await resolvePrintAssetStream(slug, bucket);
    assert.equal(result.kind === "json", true, slug);
    assert.equal(result.kind === "json" && result.status, 503, slug);
    assert.equal(result.kind === "json" && result.body.error, "print-asset-unavailable", slug);
  }
  assert.equal(called, 0, "no lookup may be attempted for a slug with no print asset");
});

// The future-exp bound is TTL + a clock-skew pad. Both halves matter and the
// pad is not part of the TTL, so the boundary is asserted at the exact second:
// one second past it must be rejected, which is what makes the pad a stated
// number rather than an unbounded fudge factor.
test("a future exp is accepted exactly up to TTL plus the skew pad, and no further", async () => {
  const nowMs = Date.parse("2026-09-28T12:00:00.000Z");
  const nowSec = Math.floor(nowMs / 1000);
  // Mirrors CLOCK_SKEW_PAD_SECONDS in src/application/fulfillment/print-asset.ts, which is
  // module-internal and so not importable here; a second spelling on purpose.
  const PAD = 300;

  const at = async (exp: number) =>
    verifyPrintAssetRequest(SAMPLE_SLUG, String(exp), "0".repeat(64), SIGNER, { secret: SECRET, nowMs });

  // Inside the bound: rejected on signature, not on the exp window. A wrong
  // signature is the only way to probe the window without forging a valid one.
  const edge = await at(nowSec + PRINT_ASSET_TTL_SECONDS + PAD);
  assert.equal(edge.ok, false);
  if (!edge.ok) assert.equal(edge.error, "bad-signature");

  const past = await at(nowSec + PRINT_ASSET_TTL_SECONDS + PAD + 1);
  assert.equal(past.ok, false);
  if (!past.ok) assert.equal(past.error, "invalid-exp");
});

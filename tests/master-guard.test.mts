import assert from "node:assert/strict";
import test from "node:test";
import { MASTERS_BUCKET, referencesMasters } from "../src/lib/master-guard.ts";
import { MASTERS_BUCKET_NAME } from "../src/lib/derivative-ladder.ts";
import { assertNoMasterLeak } from "../src/lib/prodigi-order.ts";
import { decideFulfillment, parseOrderRecord, resolveDownload } from "../src/lib/fulfillment.ts";
import {
  PHOTO_SLUG_PATTERN,
  isMasterKey,
  masterKeyForSlug,
} from "../src/lib/master-key.ts";
import { isPhotoSlug } from "../src/lib/print-asset.ts";
import { PHOTOS, getPhoto } from "../src/lib/photos.ts";

const SESSION = "cs_test_12345678abcd";

test("referencesMasters matches bucket names and prints/ key paths, any case", () => {
  assert.equal(referencesMasters("https://nessebarlens.com/placeholders/dawn.jpg"), false);
  assert.equal(
    referencesMasters(`https://r2.example/${MASTERS_BUCKET}/prints/dawn.jpg`),
    true,
  );
  assert.equal(referencesMasters("prints/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/PRINTS/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/Prints/dawn.jpg"), true);
  assert.equal(referencesMasters("https://x.test/api/print-asset?slug=dawn"), false);
  // The signed print-asset route is the one place "print" is allowed, and it
  // is "print-asset" with a hyphen, never "print/".
  assert.equal(referencesMasters("https://x.test/print-asset"), false);
});

test("assertNoMasterLeak rejects a master key in any case", () => {
  // The old check was case-sensitive, so "PRINTS/dawn.jpg" passed the order
  // body guard while the same string was rejected elsewhere.
  assert.throws(
    () => assertNoMasterLeak({ url: "https://x.test/PRINTS/dawn.jpg" }),
    /master-leak/,
  );
  assert.throws(
    () => assertNoMasterLeak({ url: "https://x.test/Prints/dawn.jpg" }),
    /master-leak/,
  );
  assert.throws(
    () => assertNoMasterLeak({ url: "prints/dawn.jpg" }),
    /master-leak/,
  );
  // The bucket name keeps its own message so the two causes stay tellable.
  assert.throws(
    () => assertNoMasterLeak({ url: `https://r2.example/${MASTERS_BUCKET}/a.jpg` }),
    /masters bucket referenced/,
  );
  assert.doesNotThrow(() =>
    assertNoMasterLeak({ url: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=ab" }),
  );
});

test("parseOrderRecord rejects a master asset URL in any case", () => {
  const record = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: "dawn",
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: "https://nessebarlens.com/api/print-asset?slug=dawn&exp=1&sig=ab",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  assert.ok(parseOrderRecord(JSON.stringify(record)));
  for (const assetUrl of [
    "https://nessebarlens.com/PRINT-ASSET/../PRINTS/dawn.jpg",
    "https://nessebarlens.com/Prints/dawn.jpg",
  ]) {
    assert.equal(
      parseOrderRecord(JSON.stringify({ ...record, assetUrl })),
      null,
      assetUrl,
    );
  }
});

test("isMasterKey accepts exactly prints/{slug}.jpg and nothing looser", () => {
  assert.equal(isMasterKey("prints/dawn.jpg"), true);
  assert.equal(isMasterKey("prints/saint-spiridov.jpg"), true);
  for (const key of [
    "Prints/dawn.jpg",
    "prints/Dawn.jpg",
    "prints/dawn.png",
    "prints/dawn.jpg/../other",
    "masters/prints/dawn.jpg",
    "prints/dawn",
    "x/prints/dawn.jpg",
    "",
  ]) {
    assert.equal(isMasterKey(key), false, key);
  }
});

test("the slug pattern is shared, and masterKeyForSlug resolves through the catalog", () => {
  // print-asset's isPhotoSlug used to carry its own copy of this grammar.
  for (const slug of PHOTOS.map((p) => p.slug)) {
    assert.equal(isPhotoSlug(slug), PHOTO_SLUG_PATTERN.test(slug), slug);
    assert.equal(masterKeyForSlug(slug), getPhoto(slug)?.imageKey, slug);
  }
  for (const bad of ["", "Dawn", "dawn_1", "-dawn", "dawn-", "dawn.jpg", "a".repeat(300)]) {
    assert.equal(masterKeyForSlug(bad), null, bad);
    if (bad !== "a".repeat(300)) {
      // The pattern itself sets no length cap; only the catalog gates a slug.
      assert.equal(PHOTO_SLUG_PATTERN.test(bad), false, bad);
    }
  }
  // Every catalog slug and imageKey satisfies the shared grammar.
  for (const photo of PHOTOS) {
    assert.equal(isPhotoSlug(photo.slug), true, photo.slug);
    assert.equal(isMasterKey(photo.imageKey), true, photo.imageKey);
  }
});

test("the download filename is gated by the shared slug grammar, not a private copy", async () => {
  // resolveDownload used to inline a second copy of PHOTO_SLUG_PATTERN, so the
  // two could drift: a slug the catalog accepted could be renamed to
  // download.jpg. Drive the real resolver over slugs on both sides of the
  // grammar and assert it agrees with the one pattern.
  const decided = decideFulfillment({
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 3000,
    metadata: { photoSlug: "dawn", format: "digital", quoteEur: "30" },
    shippingDetails: null,
    customerEmail: "a@example.com",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(decided.action, "write");
  if (decided.action !== "write") return;
  const bytes = {
    async get() {
      return { body: new ReadableStream(), size: 7 };
    },
  };
  for (const slug of ["dawn", "harbor-mist", "Not A Slug", "dawn_1", "", "dawn.jpg"]) {
    const streamed = await resolveDownload({ ...decided.record, photoSlug: slug }, bytes);
    assert.equal(streamed.kind, "stream", slug);
    assert.equal(
      streamed.kind === "stream" ? streamed.filename : "",
      PHOTO_SLUG_PATTERN.test(slug) ? `${slug}.jpg` : "download.jpg",
      slug,
    );
  }
});

test("the masters bucket name is declared once, in the ladder module", () => {
  // This module owns the *marker* — what counts as pointing at masters — not
  // the spelling of the bucket. It aliases the ladder's constant so renaming
  // a bucket is a one-line change, and this assertion is what would catch a
  // second literal creeping back in beside it.
  assert.equal(MASTERS_BUCKET, MASTERS_BUCKET_NAME);
});

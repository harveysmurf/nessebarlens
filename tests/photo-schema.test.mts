/**
 * Every rule in the photo-file table, with a passing and a failing case, and
 * the cross-field rules a single file can express. The catalog-level rules
 * (one featured photo, slug equals filename across a directory) live in
 * tests/build-catalog.test.mts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  FILM_LOOKS,
  PHOTO_CATEGORIES,
  validatePhotoFile,
} from "../src/domain/catalog/photo-schema.ts";

const REQUIRED = {
  title: "A Title",
  caption: "A Caption",
  description: "A description.",
  alt: "A one-line description of the image",
  category: "fine-art",
};

/** The two values `publish-photos` writes; required for a published photo. */
const HASHES = { master_sha256: "a".repeat(64), image_hash: "abcdef12" };

/** The three values `publish-photos` / #297 sync backfills; required for a published photo. */
const FACTS = { master_width: 4901, master_height: 3351, orientation: "landscape" };

/** The print asset's two keys (#307); required for a published photo in PR 2. */
const PRINT_ASSET = { print_asset_sha256: "b".repeat(64), print_asset_md5: "c".repeat(32) };

/** The print offer (#300); required for a published photo. Valid for FACTS. */
const PRINT_OPTIONS = {
  print_options: { giclee: ["30x40"], framed: ["30x40"], canvas: ["30x40"] },
};

/** A valid, published photo. */
const VALID = { ...REQUIRED, ...HASHES, ...FACTS, ...PRINT_ASSET, ...PRINT_OPTIONS };

function validate(data: unknown, filename = "photo") {
  return validatePhotoFile(filename, data);
}

function problems(data: unknown, filename = "photo"): string[] {
  const result = validate(data, filename);
  assert.equal(result.ok, false, "expected a failure");
  return result.ok ? [] : result.problems;
}

function validateRelaxed(data: unknown, filename = "photo") {
  return validatePhotoFile(filename, data, {
    requirePublishedHashes: false,
    requireMasterFacts: false,
    requirePrintAssets: false,
    requirePrintOffer: false,
  });
}

test("an unpublished file needs no hashes and applies defaults", () => {
  const result = validate({ ...REQUIRED, published: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.photo.slug, "photo");
  assert.equal(result.photo.title, "A Title");
  assert.equal(result.photo.caption, "A Caption");
  assert.equal(result.photo.description, "A description.");
  assert.equal(result.photo.alt, "A one-line description of the image");
  assert.equal(result.photo.category, "fine-art");
  assert.equal(result.photo.filmLook, undefined);
  assert.equal(result.photo.order, undefined);
  assert.equal(result.photo.featured, undefined);
  assert.equal(result.photo.heroCaption, undefined);
  assert.equal(result.photo.masterSha256, undefined);
  assert.equal(result.photo.imageHash, undefined);
  assert.equal(result.photo.published, false);
});

test("a published photo without master_sha256 or image_hash fails", () => {
  const missingBoth = problems({ ...REQUIRED });
  assert.ok(
    missingBoth.some((p) => p.includes("master_sha256: required")),
    missingBoth.join("; "),
  );
  assert.ok(
    missingBoth.some((p) => p.includes("image_hash: required")),
    missingBoth.join("; "),
  );
  const noMaster = problems({ ...REQUIRED, image_hash: "abcdef12" });
  assert.ok(
    noMaster.some((p) => p.includes("master_sha256: required")),
    noMaster.join("; "),
  );
  assert.equal(
    validate({ ...REQUIRED, ...HASHES, ...FACTS, ...PRINT_ASSET, ...PRINT_OPTIONS }).ok,
    true,
  );
});

test("a fully-specified file validates and keeps every field", () => {
  const result = validate({
    ...VALID,
    category: "film",
    film_look: "contrast",
    order: 3,
    featured: true,
    hero_caption: "Hero copy",
    published: false,
    master_sha256: "a".repeat(64),
    image_hash: "abcdef12",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.photo.category, "film");
  assert.equal(result.photo.filmLook, "contrast");
  assert.equal(result.photo.order, 3);
  assert.equal(result.photo.featured, true);
  assert.equal(result.photo.heroCaption, "Hero copy");
  assert.equal(result.photo.published, false);
  assert.equal(result.photo.masterSha256, "a".repeat(64));
  assert.equal(result.photo.imageHash, "abcdef12");
});

test("every category is accepted", () => {
  for (const category of PHOTO_CATEGORIES) {
    const result = validate({ ...VALID, category });
    assert.equal(result.ok, true, category);
  }
});

test("every film look is accepted on a film photo", () => {
  for (const film_look of FILM_LOOKS) {
    const result = validate({ ...VALID, category: "film", film_look });
    assert.equal(result.ok, true, film_look);
  }
});

test("a non-mapping file is refused", () => {
  assert.deepEqual(validate("nope").ok, false);
  assert.deepEqual(validate(null).ok, false);
  assert.deepEqual(validate(["a"]).ok, false);
});

test("unknown keys are an error, not ignored", () => {
  const found = problems({ ...VALID, catgory: "film" });
  assert.ok(
    found.some((p) => p.includes("catgory") && p.includes("unknown key")),
    found.join("; "),
  );
});

test("slug defaults to the filename and may repeat it", () => {
  assert.equal(validate({ ...VALID }, "dawn").ok, true);
  const echoed = validate({ ...VALID, slug: "dawn" }, "dawn");
  assert.equal(echoed.ok, true);
});

test("a slug that differs from the filename fails", () => {
  const found = problems({ ...VALID, slug: "dusk" }, "dawn");
  assert.ok(found.some((p) => p.includes("must equal the filename")), found.join("; "));
});

test("an invalid slug fails even when it matches the filename", () => {
  const found = problems({ ...VALID }, "Not A Slug");
  assert.ok(found.some((p) => p.includes("not a valid slug")), found.join("; "));
});

test("a non-string slug fails", () => {
  const found = problems({ ...VALID, slug: 7 }, "dawn");
  assert.ok(found.some((p) => p.includes("slug: must be a string")), found.join("; "));
});

test("title must be a non-empty string", () => {
  for (const title of [undefined, "", "   ", 5]) {
    const found = problems({ ...VALID, title });
    assert.ok(found.some((p) => p.startsWith("title:")), JSON.stringify(title));
  }
});

test("caption must be present and a string", () => {
  for (const caption of [undefined, 5]) {
    const found = problems({ ...VALID, caption });
    assert.ok(found.some((p) => p.startsWith("caption:")), JSON.stringify(caption));
  }
});

test("description must be present and a string", () => {
  for (const description of [undefined, 5]) {
    const found = problems({ ...VALID, description });
    assert.ok(
      found.some((p) => p.startsWith("description:")),
      JSON.stringify(description),
    );
  }
});

test("alt is required, must be a string, and is capped at 200 characters", () => {
  for (const alt of [undefined, "", "  ", 5]) {
    const found = problems({ ...VALID, alt });
    assert.ok(found.some((p) => p.startsWith("alt:")), JSON.stringify(alt));
  }
  assert.equal(validate({ ...VALID, alt: "x".repeat(200) }).ok, true);
  const tooLong = problems({ ...VALID, alt: "x".repeat(201) });
  assert.ok(tooLong.some((p) => p.includes("200 characters")), tooLong.join("; "));
  // Multi-line alt is still a string, but the length is the whole value.
  assert.equal(validate({ ...VALID, alt: "line one\nline two" }).ok, true);
});

test("category must be one of the fixed list", () => {
  const unknown = problems({ ...VALID, category: "panorama" });
  assert.ok(unknown.some((p) => p.startsWith("category:")), unknown.join("; "));
  const wrongType = problems({ ...VALID, category: 7 });
  assert.ok(wrongType.some((p) => p.startsWith("category:")), wrongType.join("; "));
  const missing = problems({ ...VALID, category: undefined });
  assert.ok(missing.some((p) => p.startsWith("category:")), missing.join("; "));
});

test("film_look is optional, must be a known look, and is film-only", () => {
  assert.equal(validate({ ...VALID, film_look: undefined }).ok, true);
  const bad = problems({ ...VALID, category: "film", film_look: "vivid" });
  assert.ok(bad.some((p) => p.startsWith("film_look:")), bad.join("; "));
  const wrongType = problems({ ...VALID, category: "film", film_look: 7 });
  assert.ok(wrongType.some((p) => p.startsWith("film_look:")), wrongType.join("; "));
  const onFineArt = problems({ ...VALID, film_look: "contrast" });
  assert.ok(
    onFineArt.some((p) => p.includes("only allowed when category is film")),
    onFineArt.join("; "),
  );
});

test("order is optional and must be an integer", () => {
  assert.equal(validate({ ...VALID, order: undefined }).ok, true);
  assert.equal(validate({ ...VALID, order: 0 }).ok, true);
  assert.equal(validate({ ...VALID, order: -2 }).ok, true);
  for (const order of [1.5, "first"]) {
    const found = problems({ ...VALID, order });
    assert.ok(found.some((p) => p.startsWith("order:")), JSON.stringify(order));
  }
});

test("featured is optional and must be a boolean", () => {
  assert.equal(validate({ ...VALID, featured: false }).ok, true);
  const found = problems({ ...VALID, featured: "yes" });
  assert.ok(found.some((p) => p.startsWith("featured:")), found.join("; "));
});

test("hero_caption is required with featured and forbidden without it", () => {
  assert.equal(
    validate({ ...VALID, featured: true, hero_caption: "Hero" }).ok,
    true,
  );
  const missing = problems({ ...VALID, featured: true, hero_caption: undefined });
  assert.ok(
    missing.some((p) => p.startsWith("hero_caption:")),
    missing.join("; "),
  );
  const badType = problems({ ...VALID, featured: true, hero_caption: 7 });
  assert.ok(badType.some((p) => p.startsWith("hero_caption:")), badType.join("; "));
  const withoutFeatured = problems({ ...VALID, hero_caption: "Hero" });
  assert.ok(
    withoutFeatured.some((p) =>
      p.includes("only allowed when featured is true"),
    ),
    withoutFeatured.join("; "),
  );
});

test("published is optional, defaults true, and must be a boolean", () => {
  const off = validate({ ...VALID, published: false });
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.photo.published, false);
  const found = problems({ ...VALID, published: "no" });
  assert.ok(found.some((p) => p.startsWith("published:")), found.join("; "));
});

test("master_sha256 must be 64-char lowercase hex", () => {
  assert.equal(validate({ ...VALID, master_sha256: "0".repeat(64) }).ok, true);
  const upper = problems({ ...VALID, master_sha256: "A".repeat(64) });
  assert.ok(
    upper.some((p) => p.includes("64-character lowercase hex")),
    upper.join("; "),
  );
  const short = problems({ ...VALID, master_sha256: "abc" });
  assert.ok(short.some((p) => p.startsWith("master_sha256:")), short.join("; "));
  const wrongType = problems({ ...VALID, master_sha256: 7 });
  assert.ok(
    wrongType.some((p) => p.startsWith("master_sha256:")),
    wrongType.join("; "),
  );
});

test("image_hash must be 8-char lowercase hex", () => {
  assert.equal(validate({ ...VALID, image_hash: "0123abcd" }).ok, true);
  const upper = problems({ ...VALID, image_hash: "ABCDEF12" });
  assert.ok(
    upper.some((p) => p.includes("8-character lowercase hex")),
    upper.join("; "),
  );
  const short = problems({ ...VALID, image_hash: "abc" });
  assert.ok(short.some((p) => p.startsWith("image_hash:")), short.join("; "));
  const wrongType = problems({ ...VALID, image_hash: 7 });
  assert.ok(wrongType.some((p) => p.startsWith("image_hash:")), wrongType.join("; "));
});

test("an unpublished photo may omit master facts", () => {
  const result = validate({ ...REQUIRED, published: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.photo.master, undefined);
  // And a draft that has hashes but no facts is fine too.
  assert.equal(validate({ ...REQUIRED, published: false, ...HASHES }).ok, true);
});

test("a published photo without master facts fails (#297)", () => {
  const withoutFacts = problems({ ...REQUIRED, ...HASHES });
  assert.ok(
    withoutFacts.some((p) => p.includes("master_width, master_height and orientation")),
    withoutFacts.join("; "),
  );
});

test("requireMasterFacts: false lets a published photo pass without facts", () => {
  const result = validateRelaxed({ ...REQUIRED, ...HASHES, ...PRINT_ASSET });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.photo.master, undefined);
});

test("a complete set of master facts is accepted and kept", () => {
  const result = validate({
    ...VALID,
    master_width: 4901,
    master_height: 3351,
    orientation: "landscape",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.photo.master, {
      width: 4901,
      height: 3351,
      orientation: "landscape",
    });
  }
});

test("a malformed set of master facts is refused, keyed to its reason", () => {
  const notInteger = problems({ ...VALID, master_width: 0, master_height: 100, orientation: "landscape" });
  assert.ok(
    notInteger.some((p) => p.includes("positive integers")),
    notInteger.join("; "),
  );

  const unknown = problems({ ...VALID, master_width: 100, master_height: 100, orientation: "diagonal" });
  assert.ok(
    unknown.some((p) => p.includes("one of landscape, portrait, square")),
    unknown.join("; "),
  );

  const mismatch = problems({ ...VALID, master_width: 4000, master_height: 3000, orientation: "portrait" });
  assert.ok(
    mismatch.some((p) => p.includes("does not match")),
    mismatch.join("; "),
  );
});

test("a half-written set of master facts is refused rather than ignored", () => {
  const onlyWidth = problems({ ...REQUIRED, ...HASHES, master_width: 4901 });
  assert.ok(
    onlyWidth.some((p) => p.includes("positive integers")),
    onlyWidth.join("; "),
  );
  const noOrientation = problems({ ...REQUIRED, ...HASHES, master_width: 4901, master_height: 3351 });
  assert.ok(
    noOrientation.some((p) => p.includes("one of landscape, portrait, square")),
    noOrientation.join("; "),
  );
});

test("one run reports every problem in the file, not only the first", () => {
  const found = problems({
    catgory: "film",
    title: "",
    alt: "x".repeat(201),
  });
  assert.ok(found.some((p) => p.includes("catgory")), found.join("; "));
  assert.ok(found.some((p) => p.startsWith("title:")), found.join("; "));
  assert.ok(found.some((p) => p.startsWith("caption:")), found.join("; "));
  assert.ok(found.some((p) => p.startsWith("alt:")), found.join("; "));
  assert.ok(found.length >= 5, found.join("; "));
});

// ---------------------------------------------------------------------------
// Print asset (#307)
// ---------------------------------------------------------------------------

test("a published photo requires a print asset by default, and keeps it (#307 PR 2)", () => {
  // The default now requires the pair: without it checkout would send Prodigi
  // the unrotated master. A published photo that carries neither key fails.
  const without = problems({
    ...VALID,
    print_asset_sha256: undefined,
    print_asset_md5: undefined,
  });
  assert.ok(
    without.some((p) => p.includes("print_asset_sha256 and print_asset_md5: required")),
    without.join("; "),
  );
  const withAsset = validate(VALID);
  assert.equal(withAsset.ok, true);
  if (!withAsset.ok) return;
  assert.deepEqual(withAsset.photo.printAsset, {
    sha256: "b".repeat(64),
    md5: "c".repeat(32),
  });
});

test("a print asset half-written is refused, and bad hex is refused (#307)", () => {
  // A base with no print asset, so a single key is genuinely half-written.
  const noAsset = { ...REQUIRED, ...HASHES, ...FACTS };
  const onlySha = problems({ ...noAsset, print_asset_sha256: "b".repeat(64) });
  assert.ok(
    onlySha.some((p) => p.includes("required together")),
    onlySha.join("; "),
  );
  const onlyMd5 = problems({ ...noAsset, print_asset_md5: "c".repeat(32) });
  assert.ok(
    onlyMd5.some((p) => p.includes("required together")),
    onlyMd5.join("; "),
  );
  const shortSha = problems({ ...noAsset, print_asset_sha256: "b".repeat(63), print_asset_md5: "c".repeat(32) });
  assert.ok(shortSha.some((p) => p.includes("print_asset_sha256: must be 64")), shortSha.join("; "));
  const upperMd5 = problems({ ...noAsset, print_asset_sha256: "b".repeat(64), print_asset_md5: "C".repeat(32) });
  assert.ok(upperMd5.some((p) => p.includes("print_asset_md5: must be 32")), upperMd5.join("; "));
  const badMd5 = problems({ ...noAsset, print_asset_sha256: "b".repeat(64), print_asset_md5: "z".repeat(32) });
  assert.ok(badMd5.some((p) => p.includes("print_asset_md5: must be 32")), badMd5.join("; "));
});

test("requirePrintAssets: true fails a published photo without one (PR 2)", () => {
  const result = validatePhotoFile(
    "photo",
    { ...REQUIRED, ...HASHES, ...FACTS },
    { requirePrintAssets: true },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.problems.some((p) => p.includes("print_asset_sha256 and print_asset_md5: required")),
    result.problems.join("; "),
  );
  // With the asset present the requirement is satisfied.
  assert.equal(validatePhotoFile("photo", VALID, { requirePrintAssets: true }).ok, true);
});

// ---------------------------------------------------------------------------
// Print offer (#300)
// ---------------------------------------------------------------------------

test("a published photo requires print_options by default, and keeps it (#300)", () => {
  const without = problems({ ...VALID, print_options: undefined });
  assert.ok(
    without.some((p) => p.includes("print_options: required for a published photo")),
    without.join("; "),
  );
  const result = validate(VALID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.photo.printOffer, {
    giclee: ["30x40"],
    framed: ["30x40"],
    canvas: ["30x40"],
  });
});

test("requirePrintOffer: false lets a published photo pass without an offer", () => {
  const result = validatePhotoFile(
    "photo",
    { ...REQUIRED, ...HASHES, ...FACTS, ...PRINT_ASSET },
    { requirePrintOffer: false },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.photo.printOffer, undefined);
});

test("every offer problem maps to a print_options field: message line (#300)", () => {
  const cases: Array<[unknown, RegExp]> = [
    ["nope", /print_options: must be a map of format to a list of sizes/],
    [{}, /print_options\.(giclee|framed|canvas): required/],
    [{ giclee: [], framed: [], canvas: [], digital: [] }, /print_options\.digital: unknown format/],
    [{ giclee: "30x40", framed: [], canvas: [] }, /print_options\.giclee: must be a list of sizes/],
    [{ giclee: ["99x99"], framed: [], canvas: [] }, /print_options\.giclee\.99x99: unknown size/],
    [
      { giclee: ["30x40", "30x40"], framed: [], canvas: [] },
      /print_options\.giclee\.30x40: listed more than once/,
    ],
    [
      { giclee: ["70x100"], framed: [], canvas: [] },
      /print_options\.giclee\.70x100: below the \d+ PPI minimum/,
    ],
  ];
  for (const [print_options, re] of cases) {
    const found = problems({ ...VALID, print_options });
    assert.ok(found.some((p) => re.test(p)), `${JSON.stringify(print_options)} → ${found.join("; ")}`);
  }
});

test("an option that does not match a square master is a shape problem (#300)", () => {
  const found = problems({
    ...VALID,
    master_width: 4000,
    master_height: 4000,
    orientation: "square",
    print_options: { giclee: ["30x40"], framed: [], canvas: [] },
  });
  assert.ok(
    found.some((p) => p === "print_options.giclee.30x40: does not match the master's shape"),
    found.join("; "),
  );
});

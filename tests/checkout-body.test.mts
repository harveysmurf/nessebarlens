import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckoutBody, parseQuoteBody } from "../src/lib/checkout-body.ts";
import {
  FRAME_FINISHES,
  PHYSICAL_FORMATS,
  PRINT_SIZES,
  SELLABLE_FORMATS,
  allPhysicalSkus,
  formatListLabel,
} from "../src/lib/sku-map.ts";

const SLUG = { photoSlug: "saint-spiridov" };

test("checkout accepts every format×size the SKU table can build", () => {
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      const frame = format === "framed" ? "brown" : null;
      const parsed = parseCheckoutBody({ ...SLUG, format, size, frame });
      assert.deepEqual(parsed, {
        photoSlug: SLUG.photoSlug,
        format,
        size,
        frame,
        destinationCountryCode: null,
      });
      // Guard the SKU table itself so validation coverage is meaningful.
      assert.ok(allPhysicalSkus().some((e) => e.sizeCm === size));
    }
  }
});

test("checkout accepts digital and rejects size/frame for it", () => {
  const ok = parseCheckoutBody({ ...SLUG, format: "digital" });
  assert.deepEqual(ok, { ...SLUG, format: "digital", destinationCountryCode: null });
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "digital", size: "30x40" })),
    /digital rejects size/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "digital", frame: "black" })),
    /digital rejects frame/,
  );
});

test("checkout accepts every frame finish and requires one for framed", () => {
  for (const frame of FRAME_FINISHES) {
    const parsed = parseCheckoutBody({ ...SLUG, format: "framed", size: "50x70", frame });
    assert.equal((parsed as { frame: string }).frame, frame);
  }
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "framed", size: "50x70" })),
    /frame required/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "50x70", frame: "black" })),
    /frame only allowed/,
  );
});

test("checkout rejects unknown format, size, and missing photoSlug", () => {
  assert.match(JSON.stringify(parseCheckoutBody({ ...SLUG, format: "poster", size: "30x40" })), /format must be/);
  assert.match(JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "99x99" })), /size required/);
  assert.match(JSON.stringify(parseCheckoutBody({ format: "giclee", size: "30x40" })), /photoSlug required/);
});

test("quote accepts every physical SKU combination and rejects digital", () => {
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      const frame = format === "framed" ? "white" : null;
      const parsed = parseQuoteBody({ format, size, frame });
      assert.deepEqual(parsed, { format, size, frame, destinationCountryCode: null });
    }
  }
  assert.match(
    JSON.stringify(parseQuoteBody({ format: "digital" })),
    /digital has no Prodigi quote/,
  );
});

test("checkout and quote share destination country validation", () => {
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "usa" })),
    /2-letter ISO/,
  );
  assert.match(
    JSON.stringify(parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "AN" })),
    /ship-to country/,
  );
  const ok = parseCheckoutBody({ ...SLUG, format: "giclee", size: "30x40", destinationCountryCode: "DE" });
  assert.equal((ok as { destinationCountryCode: string }).destinationCountryCode, "DE");
});

test("rejection messages list the allow-lists, not a hand-written copy", () => {
  // The strings a buyer reads must track sku-map, or a new size ships with a
  // message that still says "30x40|50x70|70x100".
  const badSize = parseCheckoutBody({
    photoSlug: "dawn",
    format: "giclee",
    size: "40x30",
  });
  assert.equal("error" in badSize, true);
  assert.ok(badSize.error.includes(PRINT_SIZES.join("|")), badSize.error);

  const badFormat = parseCheckoutBody({ photoSlug: "dawn", format: "poster" });
  assert.equal("error" in badFormat, true);
  assert.ok(badFormat.error.includes(SELLABLE_FORMATS.join("|")), badFormat.error);

  const badFrame = parseCheckoutBody({
    photoSlug: "dawn",
    format: "framed",
    size: PRINT_SIZES[0],
    frame: "gold",
  });
  assert.equal("error" in badFrame, true);
  assert.ok(badFrame.error.includes(FRAME_FINISHES.join("|")), badFrame.error);

  const badQuoteFormat = parseQuoteBody({ format: "poster", size: PRINT_SIZES[0] });
  assert.equal("error" in badQuoteFormat, true);
  assert.ok(
    badQuoteFormat.error.includes(PHYSICAL_FORMATS.join("|")),
    badQuoteFormat.error,
  );
});

test("SELLABLE_FORMATS is the physical list plus digital, defined once", () => {
  assert.deepEqual(SELLABLE_FORMATS, [...PHYSICAL_FORMATS, "digital"]);
  assert.equal(new Set(SELLABLE_FORMATS).size, SELLABLE_FORMATS.length);
});

test("formatListLabel is the join the parsers use", () => {
  assert.equal(formatListLabel(["a", "b", "c"]), "a|b|c");
  assert.equal(formatListLabel(["a", "b"], ", "), "a, b");
  assert.equal(formatListLabel([]), "");
});

test("a non-object checkout body is rejected before any field is read", () => {
  for (const raw of [null, undefined, 0, 42, "", "photoSlug=dawn", true]) {
    assert.deepEqual(parseCheckoutBody(raw), { error: "Invalid JSON body" }, String(raw));
  }
  // An array is typeof "object", so it gets the next error rather than the
  // shape error. Pinned because a caller might read that difference as a bug.
  assert.deepEqual(parseCheckoutBody([]), { error: "photoSlug required" });
});

test("a quote with no frame is accepted; a frame on a non-framed format is not", () => {
  const giclee = parseQuoteBody({ format: "giclee", size: "30x40" });
  assert.deepEqual(giclee, { format: "giclee", size: "30x40", frame: null, destinationCountryCode: null });
  // An explicitly undefined frame is as absent as a null one.
  const undefinedFrame = parseQuoteBody({ format: "canvas", size: "50x70", frame: undefined });
  assert.deepEqual(undefinedFrame, { format: "canvas", size: "50x70", frame: null, destinationCountryCode: null });
  for (const frame of ["black", ""]) {
    const rejected = parseQuoteBody({ format: "giclee", size: "30x40", frame });
    assert.equal("error" in rejected, true, frame);
    assert.match("error" in rejected ? rejected.error : "", /frame only allowed/);
  }
});

test("a quote body that is not an object is rejected before any field is read", () => {
  // The route hands the parsed JSON straight in, so null, a bare string and a
  // number all arrive here. Each has to be an error, not a field read off
  // undefined that happens to be falsy.
  for (const raw of [null, undefined, "giclee", 7, true]) {
    assert.deepEqual(parseQuoteBody(raw), { error: "Invalid JSON body" }, String(raw));
  }
});

test("a quote needs a size from the print list, and says which list", () => {
  for (const size of ["", "99x99", "12X16", 7, null, undefined, {}]) {
    const result = parseQuoteBody({ format: "giclee", size });
    assert.match(
      (result as { error: string }).error,
      /^size required/,
      JSON.stringify(size),
    );
  }
  // The message names the sizes the SKU map accepts, so a caller can correct
  // itself without reading the source.
  const { error } = parseQuoteBody({ format: "giclee" }) as { error: string };
  for (const size of PRINT_SIZES) {
    assert.equal(error.includes(size), true, size);
  }
  // A valid size is accepted, so the check is not rejecting everything.
  assert.equal(
    "size" in (parseQuoteBody({ format: "giclee", size: PRINT_SIZES[0] }) as object),
    true,
  );
});

/**
 * The frame rules are one function shared by both bodies, so a divergence
 * between the two endpoints is a regression in the shared helper. This
 * compares them case by case rather than asserting each side separately: the
 * invariant is that they answer identically, which is what a second copy
 * could quietly stop doing.
 */
test("checkout and quote apply the same frame rule, case for case", () => {
  const cases: Array<Record<string, unknown>> = [
    { format: "framed", size: "50x70", frame: "black" },
    { format: "framed", size: "50x70", frame: "chartreuse" },
    { format: "framed", size: "50x70" },
    { format: "framed", size: "50x70", frame: null },
    { format: "framed", size: "50x70", frame: "" },
    { format: "giclee", size: "50x70" },
    { format: "giclee", size: "50x70", frame: null },
    { format: "canvas", size: "30x40", frame: "black" },
    { format: "canvas", size: "30x40", frame: undefined },
  ];

  for (const c of cases) {
    const checkout = parseCheckoutBody({ ...SLUG, ...c });
    const quote = parseQuoteBody(c);
    const describe_ = JSON.stringify(c);
    assert.equal("error" in checkout, "error" in quote, `acceptance differs for ${describe_}`);
    if ("error" in checkout && "error" in quote) {
      assert.equal(checkout.error, quote.error, `error text differs for ${describe_}`);
    } else if (!("error" in checkout) && !("error" in quote)) {
      assert.equal(
        checkout.frame,
        quote.frame,
        `accepted frame differs for ${describe_}`,
      );
    }
  }
});

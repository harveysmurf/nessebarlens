import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CONFIGURATOR_FORMATS,
  CONFIGURATOR_FRAMES,
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_FORMAT,
  DEFAULT_PRINT_SIZE,
  firstOfferedSize,
  masterResolutionLabel,
  offeredFormats,
  previewCaption,
  previewLabel,
  previewNote,
  sizeOptions,
} from "../src/domain/ordering/print-copy.ts";
import type { PreviewGeometry } from "../src/domain/ordering/print-preview.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import { sizeLabel } from "../src/domain/pricing/pricing.ts";
import { FRAME_FINISHES, PRINT_SIZES, SELLABLE_FORMATS } from "../src/domain/pricing/sku-map.ts";

/** Every size on every format — the offer of a very high-resolution master. */
const FULL_OFFER = {
  giclee: ["20x30", "30x40", "30x45", "40x60", "50x70", "50x75", "60x90", "70x100"],
  framed: ["20x30", "30x40", "30x45", "40x60", "50x70", "50x75", "60x90", "70x100"],
  canvas: ["20x30", "30x40", "30x45", "40x60", "50x70", "50x75", "60x90", "70x100"],
} as const;

test("the configurator offers exactly what the catalog can sell", () => {
  // The component used to declare its own arrays. A format added to the
  // catalog — which is what pinning a new Prodigi SKU does — produced a
  // configurator that could not offer it, silently, with no type error.
  assert.deepEqual(
    offeredFormats(FULL_OFFER).map((f) => f.id),
    SELLABLE_FORMATS,
  );
  assert.deepEqual(
    sizeOptions(FULL_OFFER, "giclee", "portrait").map((s) => s.id),
    PRINT_SIZES,
  );
  assert.deepEqual(
    CONFIGURATOR_FRAMES.map((f) => f.id),
    FRAME_FINISHES,
  );
});

test("offeredFormats keeps digital and only formats with an offered size (#302)", () => {
  assert.deepEqual(offeredFormats(FULL_OFFER).map((f) => f.id), [
    "giclee",
    "framed",
    "canvas",
    "digital",
  ]);
  // A photo that offers only giclée 30x40: no framed or canvas button at all,
  // digital always present.
  assert.deepEqual(
    offeredFormats({ giclee: ["30x40"], framed: [], canvas: [] }).map((f) => f.id),
    ["giclee", "digital"],
  );
  // Nothing physical: only digital.
  assert.deepEqual(
    offeredFormats({ giclee: [], framed: [], canvas: [] }).map((f) => f.id),
    ["digital"],
  );
});

test("sizeOptions labels the offered sizes in table order for the photo (#302)", () => {
  assert.deepEqual(
    sizeOptions(FULL_OFFER, "giclee", "portrait"),
    PRINT_SIZES.map((size) => ({ id: size, label: sizeLabel(size, "portrait") })),
  );
  assert.deepEqual(sizeOptions(FULL_OFFER, "giclee", "landscape")[0], {
    id: "20x30",
    label: '30 × 20 cm (12 × 8")',
  });
  // Digital carries no size.
  assert.deepEqual(sizeOptions(FULL_OFFER, "digital", "portrait"), []);
});

test("firstOfferedSize is the first table size, and undefined for digital (#302)", () => {
  assert.equal(firstOfferedSize(FULL_OFFER, "giclee"), PRINT_SIZES[0]);
  assert.equal(
    firstOfferedSize({ giclee: ["50x70", "70x100"], framed: [], canvas: [] }, "giclee"),
    "50x70",
  );
  assert.equal(firstOfferedSize(FULL_OFFER, "digital"), undefined);
});

test("masterResolutionLabel states the master's oriented pixel size (#325)", () => {
  // The digital copy delivers the master file unchanged, so its stated
  // resolution must be the master's own width × height, formatted one way.
  const landscape: MasterFacts = { width: 7952, height: 5304, orientation: "landscape" };
  assert.equal(masterResolutionLabel(landscape), "7952 × 5304 px");
  // Portrait swaps the axes as measured; the label follows the facts, never a
  // hard-coded pair.
  const portrait: MasterFacts = { width: 5304, height: 7952, orientation: "portrait" };
  assert.equal(masterResolutionLabel(portrait), "5304 × 7952 px");
});

test("every option carries display copy, and no copy is blank", () => {
  // FORMAT_COPY is a Record keyed by the union, so tsc already refuses a
  // missing entry. What it cannot see is an entry whose text is empty, which
  // renders as an empty button.
  for (const format of CONFIGURATOR_FORMATS) {
    assert.ok(format.title.length > 0, `${format.id} has no title`);
    assert.ok(format.sub.length > 0, `${format.id} has no sub`);
  }
  for (const frame of CONFIGURATOR_FRAMES) {
    assert.ok(frame.label.length > 0, `${frame.id} has no label`);
  }
});

test("the ids are unique, so no selector renders the same option twice", () => {
  for (const list of [
    CONFIGURATOR_FORMATS.map((f) => f.id),
    CONFIGURATOR_FRAMES.map((f) => f.id),
  ]) {
    assert.equal(new Set(list).size, list.length);
  }
});

test("the component declares no option lists of its own", () => {
  // print-copy.ts is importable from node --test and the .tsx file is not, so
  // the invariant "this component does not re-declare the catalog" is checked
  // against the source. A hand-typed SIZES/FRAMES/FORMATS array here is the
  // copy coming back.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  for (const declaration of [
    /const FORMATS\b/,
    /const SIZES\b/,
    /const FRAMES\b/,
    /"30x40"/,
    /"black"/,
  ]) {
    assert.equal(
      declaration.test(source),
      false,
      `PrintConfigurator matches ${declaration}`,
    );
  }
  // The opening selection has to be one of the options, or the select opens
  // on a value the list does not contain.
  assert.ok(SELLABLE_FORMATS.includes(DEFAULT_PRINT_FORMAT));
  assert.ok(PRINT_SIZES.includes(DEFAULT_PRINT_SIZE));
  assert.ok(FRAME_FINISHES.includes(DEFAULT_FRAME_FINISH));
  // #302: the component takes its formats and sizes from the photo's offer; it
  // no longer names the full catalog lists.
  assert.ok(source.includes("offeredFormats"));
  assert.ok(source.includes("sizeOptions"));
  // #326: the component no longer owns the selection or the opening rule; it
  // applies the pure transitions from print-selection.ts.
  assert.ok(source.includes("withFormat"));
  assert.ok(source.includes("CONFIGURATOR_FRAMES"));
  assert.equal(source.includes("CONFIGURATOR_SIZES"), false);
});

test("the format options are a real radio group", () => {
  // The .tsx file is not importable from node --test, so this checks the
  // source. The options used to be four independent buttons carrying
  // aria-pressed, which announces "four toggle buttons" rather than "pick
  // one of these". A native radio group gives the group name, the selection
  // and arrow-key navigation from the browser, so what we assert is that the
  // group is still driven by the same `active` predicate that draws the
  // border — a hardcoded or inverted `checked` is the whole bug.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const active = format === f\.id;/);
  assert.match(source, /type="radio"/);
  assert.match(source, /checked=\{active\}/);
  assert.match(source, /onChange=\{\(\) => selectFormat\(f\.id\)\}/);
  // A group without a shared name is not a group: every option must be part
  // of the same named set for exclusivity and arrow keys to work.
  assert.match(source, /name="print-format"/);
  assert.doesNotMatch(source, /aria-pressed/);
});

test("the format radio inputs have ids unique within the file", () => {
  // Each option is a label + input pair, and htmlFor/for is what binds them.
  // A duplicated id silently breaks that binding, and React will not warn.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, `duplicate id in the file: ${ids.join(", ")}`);
  assert.ok(
    source.includes('htmlFor={`format-option-${f.id}`}'),
    "the label should point at the input it labels",
  );
  assert.ok(
    source.includes("id={`format-option-${f.id}`}"),
    "the option input should be the one the label points at",
  );
});

test("every select is named by a label, and every label names a select", () => {
  // Renaming a select's id without its htmlFor silently un-associates the
  // field: the label and the control are siblings, so nothing else binds them
  // and a screen reader announces an unlabelled dropdown. Matching both sets
  // is what catches that, in either direction.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  // Each match is scoped to a single opening tag (up to its `>`), so the
  // attribute is found no matter how the JSX is wrapped across lines — a
  // character-count window would silently stop matching a reformatted tag and
  // drop it from the set, turning a real regression into a green run.
  const labelled = [...source.matchAll(/<select\b[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]);
  const pointing = [...source.matchAll(/<label\b[^>]*?\bhtmlFor="([^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(labelled, ["print-size", "frame-finish", "shipping-country"]);
  assert.deepEqual(pointing, labelled, "each select needs a label with a matching htmlFor");
});


test("the checkout redirect is refused unless it is an https URL", async () => {
  // The navigation target comes from the API response, so it is untrusted
  // input. A client-side guard is only a guard if it runs before the
  // assignment, on the same synchronous path — a check placed after the
  // window.location line, or in a parallel branch, is theatre.
  const { HTTPS_URL_PATTERN } = await import("../src/domain/pricing/url-patterns.ts");
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  // The guard itself now lives in checkoutUrl(), which returns null unless the
  // payload carries an absolute https string. What still has to hold at the
  // call site is the ordering: the value is narrowed before it is navigated to,
  // and a null narrowing can never reach the assignment.
  const { checkoutUrl } = await import("../src/application/checkout/api-payloads.ts");
  assert.match(source, /const url = checkoutUrl\(data\);/);
  assert.match(source, /if \(!res\.ok\) \{/);
  assert.match(source, /if \(!url\) \{/);
  const guard = source.indexOf("checkoutUrl(data)");
  const navigate = source.indexOf("window.location.href = url");
  assert.ok(guard !== -1 && navigate !== -1, "both the guard and the navigation must exist");
  assert.ok(guard < navigate, "the https guard must run before the navigation");
  assert.equal(checkoutUrl({ url: "http://checkout.stripe.com/c/pay" }), null);
  assert.equal(
    checkoutUrl({ url: "https://checkout.stripe.com/c/pay" }),
    "https://checkout.stripe.com/c/pay",
  );

  // The pattern itself: anything that is not absolute https is refused.
  for (const bad of [
    "http://checkout.stripe.com/c/pay",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/api/checkout/relative",
    "//checkout.stripe.com/c/pay",
    "ftp://checkout.stripe.com/c/pay",
  ]) {
    assert.ok(
      !HTTPS_URL_PATTERN.test(bad),
      `${bad} must not be treated as an https redirect`,
    );
  }
  assert.ok(HTTPS_URL_PATTERN.test("https://checkout.stripe.com/c/pay"));
  assert.ok(HTTPS_URL_PATTERN.test("HTTPS://checkout.stripe.com/c/pay"));
});

test("the configurator never calls res.json() unguarded", async () => {
  // #130: both fetches parsed the response unguarded, before checking
  // `res.ok`. A 502
  // answered with an HTML error page made that reject, and the rejection was
  // caught and rendered as the customer-facing message — so a Prodigi outage
  // showed up as `Unexpected token '<'` under "Shipping estimate". The read is
  // now the tolerant readJsonResponse, and this pins the ordering: the body
  // read cannot throw, so the status check is what decides the message.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /await (?:res|response)\.json\(/,
    "an unguarded response parse can reject on a non-JSON error body",
  );
  const { readJsonResponse, requestErrorMessage } = await import(
    "../src/application/checkout/api-payloads.ts"
  );
  assert.equal(typeof readJsonResponse, "function");
  assert.equal(typeof requestErrorMessage, "function");
  // And both fetches report through it, so neither regresses alone.
  assert.equal(
    [...source.matchAll(/readJsonResponse\(/g)].length,
    2,
    "quote and checkout both need the tolerant read",
  );
  assert.equal(
    [...source.matchAll(/requestErrorMessage\(/g)].length,
    2,
  );
});

const ALT = "Harbour at dusk";

function sel(
  format: PrintSelection["format"],
  size: PrintSelection["size"] = "30x40",
  frame: PrintSelection["frame"] = "black",
): PrintSelection {
  return { format, size, frame };
}

test("previewLabel names the format, size and, for framed, the finish (#326)", () => {
  assert.equal(
    previewLabel(ALT, sel("giclee"), "landscape"),
    `${ALT} — giclée fine art print, ${sizeLabel("30x40", "landscape")}`,
  );
  assert.equal(
    previewLabel(ALT, sel("framed", "30x40", "white"), "landscape"),
    `${ALT} — framed print, ${sizeLabel("30x40", "landscape")}, Satin White frame with white mount`,
  );
  assert.equal(
    previewLabel(ALT, sel("canvas"), "landscape"),
    `${ALT} — stretched canvas, ${sizeLabel("30x40", "landscape")}, image wrapped around the edges`,
  );
  // Digital shows the whole uncropped photo, so the label is just the alt.
  assert.equal(previewLabel(ALT, sel("digital"), "landscape"), ALT);
});

test("previewCaption names the product and, for framed, the finish (#326)", () => {
  assert.equal(
    previewCaption(sel("giclee"), "landscape"),
    `Giclée Fine Art · ${sizeLabel("30x40", "landscape")}`,
  );
  assert.equal(
    previewCaption(sel("framed", "30x40", "brown"), "landscape"),
    `Framed Print · ${sizeLabel("30x40", "landscape")} · Brown Wood`,
  );
  assert.equal(
    previewCaption(sel("canvas"), "landscape"),
    `Stretched Canvas · ${sizeLabel("30x40", "landscape")}`,
  );
  assert.equal(previewCaption(sel("digital"), "landscape"), "Digital Copy · full frame");
});

test("previewNote explains the wrap, or a real trim, and nothing else (#326)", () => {
  const canvas: PreviewGeometry = {
    kind: "canvas",
    front: { width: 406.4, height: 304.8 },
    wrapMm: { x: 40.01, y: 40 },
    depthMm: 38,
    image: { x: -85.41, y: -40.01, width: 577.22, height: 384.81 },
    cropFraction: 0.1573,
  };
  assert.equal(
    previewNote(canvas),
    "The outer 4 cm of the photo wraps around the sides of the canvas.",
  );

  const trimmed: PreviewGeometry = {
    kind: "paper",
    outer: { width: 406.4, height: 304.8 },
    image: { x: -25.4, y: 0, width: 457.2, height: 304.8 },
    cropFraction: 0.1111,
  };
  assert.match(previewNote(trimmed) ?? "", /trimmed slightly/);

  const framedTrimmed: PreviewGeometry = {
    kind: "framed",
    frame: "black",
    outer: { width: 497.2, height: 344.8 },
    mouldingMm: 20,
    mount: { x: 20, y: 20, width: 457.2, height: 304.8 },
    window: { x: 70.04, y: 70.04, width: 357.12, height: 204.72 },
    image: { x: 0, y: -16.68, width: 357.12, height: 238.08 },
    cropFraction: 0.1401,
  };
  assert.match(previewNote(framedTrimmed) ?? "", /trimmed slightly/);

  // Below the 1% threshold the trim is not worth a line.
  const barely: PreviewGeometry = {
    kind: "paper",
    outer: { width: 406.4, height: 304.8 },
    image: { x: -1, y: 0, width: 410, height: 304.8 },
    cropFraction: 0.005,
  };
  assert.equal(previewNote(barely), null);
  // Digital is never trimmed.
  assert.equal(previewNote({ kind: "digital" }), null);
});

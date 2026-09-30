import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CONFIGURATOR_FORMATS,
  CONFIGURATOR_FRAMES,
  CONFIGURATOR_SIZES,
  DEFAULT_FRAME_FINISH,
  DEFAULT_PRINT_FORMAT,
  DEFAULT_PRINT_SIZE,
} from "../src/lib/print-copy.ts";
import { sizeLabel } from "../src/lib/pricing.ts";
import { FRAME_FINISHES, PRINT_SIZES, SELLABLE_FORMATS } from "../src/lib/sku-map.ts";

test("the configurator offers exactly what the catalog can sell", () => {
  // The component used to declare its own arrays. A format added to the
  // catalog — which is what pinning a new Prodigi SKU does — produced a
  // configurator that could not offer it, silently, with no type error.
  assert.deepEqual(
    CONFIGURATOR_FORMATS.map((f) => f.id),
    SELLABLE_FORMATS,
  );
  assert.deepEqual(
    CONFIGURATOR_SIZES.map((s) => s.id),
    PRINT_SIZES,
  );
  assert.deepEqual(
    CONFIGURATOR_FRAMES.map((f) => f.id),
    FRAME_FINISHES,
  );
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
  // Size labels are pricing's, not a second copy: one wording for a size.
  for (const size of CONFIGURATOR_SIZES) {
    assert.equal(size.label, sizeLabel(size.id));
  }
});

test("the ids are unique, so no selector renders the same option twice", () => {
  for (const list of [
    CONFIGURATOR_FORMATS.map((f) => f.id),
    CONFIGURATOR_SIZES.map((s) => s.id),
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
  assert.ok(source.includes("CONFIGURATOR_FORMATS"));
  assert.ok(source.includes("CONFIGURATOR_SIZES"));
  assert.ok(source.includes("CONFIGURATOR_FRAMES"));
});

test("the format buttons expose their selection with aria-pressed", () => {
  // The .tsx file is not importable from node --test, so this checks the
  // source: the pressed state must come from the same `active` predicate that
  // drives the border, so a screen reader reports the selection a sighted
  // user sees. Hardcoded or inverted values here are the whole bug.
  const source = fs.readFileSync(
    new URL("../src/components/PrintConfigurator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const active = format === f\.id;/);
  assert.match(source, /aria-pressed=\{active\}/);
});

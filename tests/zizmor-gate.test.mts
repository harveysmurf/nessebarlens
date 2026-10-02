/**
 * The zizmor gate is a filter over another tool's output, so the risk is not
 * that zizmor breaks — it is that the filter is wrong in one of two directions:
 *
 *   too wide  -> permanently red on code that is already safe, and the next
 *                person deletes the job;
 *   too narrow -> a real injection passes, which is the whole point of #112.
 *
 * A behavioural test cannot see this class of bug for the same reason the
 * `env:` fix needed a source scan: the fake and the code can agree on the wrong
 * thing. So these tests pin the classification against the finding shapes zizmor
 * actually emits, taken from real runs of zizmor 1.30.1 against this repo's
 * workflows.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { classify } = await import("../scripts/zizmor-gate.mjs");

/** A finding in zizmor 1.30.1's `--format json` shape. */
function finding(ident, confidence, severity = "Informational") {
  return {
    ident,
    desc: "",
    url: "",
    determinations: { confidence, severity, persona: "Regular" },
    locations: [
      {
        symbolic: { key: { Local: { verbatim_path: ".github/workflows/x.yml" } } },
        concrete: { location: { start_point: { row: 12, column: 8 } } },
      },
    ],
  };
}

// Measured on this repo with zizmor 1.30.1, default persona:
//
//   before the fix (9641a8b^)  2x High/High  + 6x Low/Informational
//   after  the fix (9641a8b)   0x >= Medium  + 6x Low/Informational
//
// The High/High pair was the two `github.head_ref` interpolations in preview.yml.

test("a high-confidence injection gates", () => {
  const { gating } = classify([
    finding("template-injection", "High", "High"),
  ]);
  assert.equal(gating.length, 1);
  assert.match(gating[0].label, /\.github\/workflows\/x\.yml:12$/);
});

test("the pre-fix shape would have failed the gate", () => {
  const { gating } = classify([
    finding("template-injection", "High", "High"),
    finding("template-injection", "High", "High"),
    ...Array.from({ length: 6 }, () =>
      finding("template-injection", "Low", "Informational"),
    ),
  ]);
  assert.equal(gating.length, 2);
});

test("the sanitized step-output findings do not gate", () => {
  // The reason for the confidence filter at all: these are the
  // `steps.branch.outputs.name` interpolations, safe because the value passed
  // through scripts/sanitize-branch-name.sh, which zizmor cannot trace.
  const { gating, advisory } = classify([
    finding("template-injection", "Low", "Informational"),
    finding("template-injection", "Low", "Informational"),
  ]);
  assert.deepEqual(gating, []);
  assert.equal(advisory.get("template-injection (Low/Informational)"), 2);
});

test("a medium-confidence injection gates", () => {
  const { gating } = classify([finding("template-injection", "Medium", "Low")]);
  assert.equal(gating.length, 1);
});

test("other rules are reported but never gate, however severe", () => {
  // unpinned-uses and excessive-permissions are High/High in this repo. If
  // severity alone leaked into the gate, CI would be red on day one over work
  // that has nothing to do with #112.
  const { gating, advisory } = classify([
    finding("unpinned-uses", "High", "High"),
    finding("excessive-permissions", "High", "High"),
    finding("self-repository", "High", "Low"),
    finding("artipacked", "Low", "Medium"),
  ]);
  assert.deepEqual(gating, []);
  assert.equal(advisory.size, 4);
});

test("a finding with no determinations does not slip through as safe", () => {
  // Fail closed. A zizmor version bump that reshapes the JSON must not silently
  // turn the gate into a no-op; the safe failure is red, not green.
  const { gating } = classify([{ ident: "template-injection", locations: [] }]);
  assert.equal(gating.length, 1);
});

/**
 * The tests typecheck gate is a filter over another tool's file list, so the risk
 * is not that `tsc` breaks — it is that the gate compiles zero files and reports
 * success. That is not hypothetical: the config first proposed for this gate
 * was
 *
 *   { "extends": "./tsconfig.json", "exclude": ["node_modules"] }
 *
 * which looks like "add tests back" but is not. `extends` replaces `include`
 * outright, and the inherited include lists only `.ts` and `.tsx`. Neither matches
 * `.mts`, so that config compiled 0 of the 117 test files and emitted exactly 2
 * errors, both about `worker.ts` and its `.open-next/worker.js` build artifact.
 * It would have gone green in CI while checking nothing.
 *
 * A gate that has silently stopped gating is indistinguishable from a gate that
 * passes, so these tests read the resolved program — via the same
 * `getParsedCommandLineOfConfigFile` tsc itself uses, which costs ~1s instead of
 * ~19s for a full `--listFilesOnly` — and assert on which files it actually
 * contains.
 *
 * Resolved-config assertions, not source-text assertions: a regex over
 * `tsconfig.tests-check.json` would be satisfied by a comment naming the right
 * setting, which is the same failure mode as the comment-satisfiable test this
 * suite already carries.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GATE_CONFIG = path.join(REPO_ROOT, "tsconfig.tests-check.json");

/** The program `tsc -p tsconfig.tests-check.json` would build, as tsc resolves it. */
function gateProgram() {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    GATE_CONFIG,
    /* no command-line overrides */ {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
      },
    },
  );
  assert.ok(parsed, "tsconfig.tests-check.json must parse");
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    [],
    "tsconfig.tests-check.json must be free of config diagnostics",
  );
  return parsed;
}

test("the gate config resolves without diagnostics", () => {
  assert.ok(gateProgram());
});

test("the gate compiles the test suite, not zero files", () => {
  // The regression this file exists for. `**/*.ts` does not match `.mts`; a
  // config that inherits the app's include compiles nothing and still exits 0.
  const tests = gateProgram().fileNames.filter((f) => f.includes(`${path.sep}tests${path.sep}`));
  assert.ok(
    tests.length > 100,
    `expected the whole suite in the program, got ${tests.length} file(s)`,
  );
});

test("a sample of suite files spans both the app and the scripts", () => {
  // Guards the failure where a narrower `include` picks up one directory and
  // silently drops the rest: the app modules the tests import, the script
  // modules some of them import, and the largest test file.
  const tests = new Set(
    gateProgram().fileNames.filter((f) => f.includes(`${path.sep}tests${path.sep}`)),
  );
  for (const name of [
    "fulfillment.test.mts",
    "routes.test.mts",
    "remove-orders-kv.test.mts",
    "publish-photos.test.mts",
    "fake-orders-store.mts",
  ]) {
    assert.ok(
      [...tests].some((f) => f.endsWith(name)),
      `${name} must be in the typechecked program`,
    );
  }
});

test("production code is in the gate too, via the tests' own imports", () => {
  const program = gateProgram().fileNames;
  assert.ok(
    program.some((f) => f.endsWith(path.join("src", "domain", "pricing", "sku-map.ts"))),
    "src/ must be typechecked — the suite imports it and its types are the assertions",
  );
});

test("explicit .ts import specifiers are permitted", () => {
  // Every test imports production modules by `.ts` specifier
  // (`../src/.../sku-map.ts`) because that is what node resolves. Without this
  // flag tsc rejects all 117 files with TS5097 and the real errors are noise.
  assert.equal(gateProgram().options.allowImportingTsExtensions, true);
});

test("the gate does not relax the app's strictness", () => {
  // A gate that passes because it turned `strict` off is the mirror image of one
  // that passes because it compiles nothing. `noImplicitAny` is read through
  // `getStrictOptionValue` because `strict: true` implies it and leaves it unset,
  // so asserting on the raw field would not notice an explicit relaxation.
  const { options } = gateProgram();
  assert.equal(options.strict, true);
  // `getStrictOptionValue` is a real TypeScript helper but not in its public
  // types, so name it through a narrow cast rather than reaching for `any`.
  const getStrictOptionValue = (
    ts as unknown as {
      getStrictOptionValue(o: ts.CompilerOptions, n: "noImplicitAny"): boolean;
    }
  ).getStrictOptionValue;
  assert.equal(getStrictOptionValue(options, "noImplicitAny"), true);
});

test("worker.ts stays excluded, and nothing else is", () => {
  // `worker.ts` imports `.open-next/worker.js`, an artifact `next build` produces
  // after typechecking, so it cannot be resolved in a checkout. Excluding it here
  // keeps the gate from reporting two errors that no commit can fix — but the
  // exclusion must not have been widened to `tests/` or the gate is a no-op.
  const program = gateProgram();
  assert.ok(
    !program.fileNames.some((f) => f.endsWith(`${path.sep}worker.ts`)),
    "worker.ts cannot be resolved in a checkout and must stay excluded",
  );
  assert.equal(gateProgram().raw.exclude?.includes("tests"), false);
});
/**
 * The two-program split is still a split (#401).
 *
 * The Worker globals come from `@cloudflare/workers-types`, which declares
 * `var process: any` and `var Buffer: any` at the top level of its `index.d.ts`.
 * That file is a **global script** — no top-level import or export — so including
 * it anywhere makes `process.env` unchecked for every file in that program. The
 * `/// <reference types>` in `cloudflare-env.d.ts` is the only thing that forces
 * it, and `tsconfig.tests-check.json` excludes that one file to keep it out.
 *
 * The exclusion is *sufficient* for a reason we do not control. The Node program
 * still reaches the package transitively —
 * `worker-bindings.ts` → `@opennextjs/cloudflare` → `wrangler` → `miniflare` →
 * `import '@cloudflare/workers-types'` — and TypeScript resolves that import to
 * the package's `index.ts`, which has 1070 top-level import/export lines and is
 * therefore a **module**, whose declarations do not leak. The shim lives in
 * `index.d.ts`, a global script, and that is the file not in the program.
 *
 * So the whole fix rests on which of two files a bare import resolves to. A
 * dependency bump that flips it — the package drops `index.ts`, a `types` field
 * appears, anything — and every `Buffer` in `publish-photos`, the e2e specs and
 * the test suite goes back to `any`, with no reference line anywhere in sight to
 * go looking for. Both typechecks would stay green, because `any` is a legal
 * type.
 *
 * These assertions are the thing that notices. They resolve the same programs
 * tsc resolves, through the same `getParsedCommandLineOfConfigFile` the
 * neighbouring `tsconfig-gate.test.mts` uses, and then read the resolved file
 * list rather than the config text: a config that *says* it excludes the file
 * and does not is the failure, and only the program can tell.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.join(import.meta.dirname, "..");
const WORKER_CONFIG = path.join(root, "tsconfig.json");
const NODE_CONFIG = path.join(root, "tsconfig.tests-check.json");

/**
 * The file list tsc builds for one config, as tsc resolves it.
 *
 * A real program, not just `getParsedCommandLineOfConfigFile(...).fileNames`:
 * that list is what the config's `include` matched, and it does **not** contain
 * files pulled in by a `/// <reference types>` directive — which is precisely
 * how the Workers globals enter. The neighbouring `tsconfig-gate.test.mts` can
 * get away with the cheap list because it only asserts on `include`-covered
 * paths; asserting on the reference here needs the program.
 *
 * Memoised because building one costs seconds and four tests want the same two.
 */
const fileLists = new Map<string, string[]>();
function programFiles(configPath: string): string[] {
  const cached = fileLists.get(configPath);
  if (cached) return cached;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    /* no command-line overrides */ {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
      },
    },
  );
  assert.ok(parsed, `${path.basename(configPath)} must parse`);
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    [],
    `${path.basename(configPath)} must be free of config diagnostics`,
  );
  const files = ts
    .createProgram(parsed.fileNames, parsed.options)
    .getSourceFiles()
    .map((f) => f.fileName);
  fileLists.set(configPath, files);
  return files;
}

const isWorkersTypesDeclaration = (f: string): boolean =>
  /@cloudflare[\\/]workers-types[\\/]index\.d\.ts$/.test(f);

test("the Worker program has the generated env type and the Workers globals", () => {
  const files = programFiles(WORKER_CONFIG);
  assert.ok(
    files.some((f) => f.endsWith("cloudflare-env.d.ts")),
    "tsconfig.json must compile cloudflare-env.d.ts: it declares CloudflareEnv",
  );
  // If this goes false the Worker bindings stop being typed, and because
  // `skipLibCheck` is on, nothing else in the build would say so.
  assert.ok(
    files.some(isWorkersTypesDeclaration),
    "tsconfig.json must include the Workers runtime declarations, or CloudflareEnv's binding types are unresolved",
  );
});

test("the Node program excludes the generated env type and the Workers globals", () => {
  const files = programFiles(NODE_CONFIG);
  assert.equal(
    files.filter((f) => f.endsWith("cloudflare-env.d.ts")).length,
    0,
    "tsconfig.tests-check.json must not compile cloudflare-env.d.ts: its `/// <reference types>` is what puts `process: any` in this program",
  );
  assert.equal(
    files.filter(isWorkersTypesDeclaration).length,
    0,
    "the Workers runtime declarations are a global script declaring `process: any` and `Buffer: any`; the Node program must not contain one",
  );
});

test("the Node program still reaches the tests and the app modules", () => {
  // The negative control. An exclude that took the tests out with the generated
  // file would satisfy the test above while checking nothing — which is the
  // failure `tsconfig-gate.test.mts` exists to catch, and it would apply here
  // unchanged if this file did not check the other direction.
  const files = programFiles(NODE_CONFIG);
  const tests = files.filter((f) => f.includes(`${path.sep}tests${path.sep}`));
  assert.ok(
    tests.length > 100,
    `expected the whole suite in the Node program, got ${tests.length} file(s)`,
  );
  assert.ok(
    files.some((f) => f.includes(`${path.sep}src${path.sep}`)),
    "the Node program must still compile the src modules the tests import",
  );
});

test("the two programs are not quietly the same program", () => {
  // Cheap, and it is the assertion that says what the two above are for: if the
  // exclude is ever dropped, or `extends` starts inheriting the include that
  // reaches the generated file, these lists converge and every gate still runs.
  const worker = new Set(programFiles(WORKER_CONFIG));
  const node = new Set(programFiles(NODE_CONFIG));
  const onlyInWorker = [...worker].filter((f) => !node.has(f));
  assert.ok(
    onlyInWorker.some((f) => f.endsWith("cloudflare-env.d.ts")),
    "the Worker program's program must contain something the Node program's does not",
  );
  assert.ok(
    [...node].some((f) => !worker.has(f)),
    "the Node program's program must contain something the Worker program's does not",
  );
});

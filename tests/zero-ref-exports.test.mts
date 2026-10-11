/**
 * The zero-reference export guard (#350).
 *
 * #349 unexported five symbols by hand, and the two people who ran the scan hit
 * the same false signal from opposite sides: a basename scan flagged ten live
 * components, and a `.ts`-only scan flagged MASTER_SHA256_PATTERN, which is used
 * only from two `.mjs` ops scripts. Both are include-set bugs, so the tests
 * below do not just assert "it finds a dead export" — they pin each way the set
 * can be wrong: types, extensionless component imports, and `scripts/*.mjs`.
 *
 * The classifier is driven on synthetic trees (a real temp directory, so the
 * module's own directory walk and framework-entry filter are exercised, not the
 * pure function in isolation). The last test scans this repository and asserts
 * the measured noise floor is zero, which is what turns a report into a gate.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REFERENCE_EXTENSIONS,
  REFERENCE_ROOTS,
  formatReport,
  main,
  rootCodeFiles,
  scanRepository,
} from "../scripts/zero-ref-exports.mjs";

const REPO = path.join(import.meta.dirname, "..");

/** Write `{ "src/a.ts": "..." }` into a throwaway directory and run `fn` on it. */
function withTree(files: Record<string, string>, fn: (base: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zero-ref-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(base, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const names = (base: string): string[] =>
  scanRepository(base)
    .map((finding) => `${finding.file}:${finding.name}`)
    .sort();

test("a value export no other file names is reported", () => {
  withTree(
    {
      "src/a.ts": "export const ORPHAN = 1;\n",
      "src/b.ts": "export const USED = 2;\n",
      "src/c.ts": "import { USED } from './b';\nvoid USED;\n",
    },
    (base) => {
      const findings = scanRepository(base);
      assert.deepEqual(
        findings.map((f) => ({ file: f.file, name: f.name, line: f.line })),
        [{ file: "src/a.ts", name: "ORPHAN", line: 1 }],
      );
      assert.match(formatReport(findings), /src\/a\.ts:1 {2}ORPHAN/);
    },
  );
});

test("the #349 shape: an export used only inside its own module is reported", () => {
  withTree(
    {
      // HELPER is exported and used, but only by its own module — exactly the
      // surface area #349 removed. useHelper has a real consumer outside.
      "src/a.ts":
        "export const HELPER = 1;\nexport function useHelper(): number {\n  return HELPER;\n}\n",
      "src/b.ts": "import { useHelper } from './a';\nvoid useHelper();\n",
    },
    (base) => assert.deepEqual(names(base), ["src/a.ts:HELPER"]),
  );
});

test("a value export consumed from another module is not reported", () => {
  withTree(
    {
      "src/a.ts": "export const SHARED = 1;\n",
      "src/b.ts": "import { SHARED } from './a';\nvoid SHARED;\n",
    },
    (base) => assert.deepEqual(names(base), []),
  );
});

test("type exports used only as in-file shapes are out of scope", () => {
  // ~75 of these exist in src/; a counter that ignored export kind would red
  // the whole repo. They are a module's public shape, not dead code.
  withTree(
    {
      "src/shapes.ts":
        "export type Foo = { a: number };\n" +
        "export interface Bar { b: string }\n" +
        "export function make(): Foo {\n  return { a: 1 };\n}\n" +
        "export function use(bar: Bar): string {\n  return bar.b;\n}\n",
      "src/consumer.ts": "import { make, use } from './shapes';\nvoid make();\nvoid use({ b: 'x' });\n",
    },
    (base) => assert.deepEqual(names(base), []),
  );
});

test("the #349 near-miss: an export consumed only by scripts/*.mjs is not reported", () => {
  withTree(
    {
      "src/pattern.ts": "export const MASTER_SHA256_PATTERN = /^[0-9a-f]{64}$/;\n",
      "scripts/op.mjs":
        "import { MASTER_SHA256_PATTERN } from '../src/pattern.ts';\n" +
        "export const ok = MASTER_SHA256_PATTERN.test('a'.repeat(64));\n",
    },
    (base) => {
      assert.deepEqual(names(base), []);
      // And the proof it was the scripts/ reference, not something else: drop
      // the .mjs consumer and the same export is correctly reported.
      fs.rmSync(path.join(base, "scripts/op.mjs"));
      assert.deepEqual(names(base), ["src/pattern.ts:MASTER_SHA256_PATTERN"]);
    },
  );
});

test("a `.js` consumer counts the same as a `.mjs` one", () => {
  withTree(
    {
      "src/pattern.ts": "export const P = /x/;\n",
      "scripts/op.js": "const { P } = require('../src/pattern.ts');\nvoid P;\n",
    },
    (base) => assert.deepEqual(names(base), []),
  );
});

test("a worker.ts-only consumer lives: the root's own code files are in the universe", () => {
  // The #349 near-miss was a consumer outside the scanned extensions; this is
  // the same bug one directory up. worker.ts imports from src/, and the
  // reconcile-cron helper is reached from there, so a root-only consumer must
  // count. (Masked in the real repo today only because tests/ also names it.)
  withTree(
    {
      "src/cron.ts": "export const runCron = (): number => 1;\n",
      "worker.ts": "import { runCron } from './src/cron';\nvoid runCron();\n",
    },
    (base) => {
      assert.deepEqual(names(base), []);
      // Drop the root consumer and the same export is correctly reported.
      fs.rmSync(path.join(base, "worker.ts"));
      assert.deepEqual(names(base), ["src/cron.ts:runCron"]);
    },
  );
});

test("the basename trap: a component imported by extensionless name is not reported", () => {
  // A scan keyed on filenames flagged all ten of these; they are live. The
  // exported symbol is what has to be referenced, and the import never spells
  // the filename at all.
  withTree(
    {
      "src/components/ContactForm.tsx":
        "export function ContactForm(): null {\n  return null;\n}\n",
      "src/app/contact/page.tsx":
        "import { ContactForm } from '@/components/ContactForm';\n" +
        "export default function ContactPage(): unknown {\n  return <ContactForm />;\n}\n",
    },
    (base) => assert.deepEqual(names(base), []),
  );
});

test("Next.js entry files are skipped, but their siblings are still checked", () => {
  withTree(
    {
      // Framework consumers: the default export, GET/POST and the route config.
      "src/app/mystery/page.tsx":
        "export default function MysteryPage(): null {\n  return null;\n}\n",
      "src/app/api/thing/route.ts":
        "export const dynamic = 'force-dynamic';\n" +
        "export async function POST(): Promise<Response> {\n  return new Response();\n}\n",
      // A genuine orphan in the same tree still fails, so the skip is a
      // carve-out for entry files and not a hole for everything under src/.
      "src/domain/orphan.ts": "export const ORPHAN = 1;\n",
    },
    (base) => assert.deepEqual(names(base), ["src/domain/orphan.ts:ORPHAN"]),
  );
});

test("references are read from the AST, so a name in a string is not a consumer", () => {
  withTree(
    {
      "src/a.ts": "export const ORPHAN = 1;\n",
      // Mentions ORPHAN only in a comment and a string; neither imports it.
      "src/b.ts": "// ORPHAN is intentionally unexported later\nconst s = 'ORPHAN';\nvoid s;\n",
    },
    (base) => assert.deepEqual(names(base), ["src/a.ts:ORPHAN"]),
  );
});

test("main is report-only by default and gates with --gate", () => {
  withTree({ "src/a.ts": "export const ORPHAN = 1;\n" }, (base) => {
    let printed = "";
    const write = (text: string): void => {
      printed += text;
    };
    assert.equal(main([], base, write), 0, "report-only must not fail the run");
    assert.match(printed, /ORPHAN/);
    assert.equal(main(["--gate"], base, write), 1, "--gate must fail on findings");
  });
  withTree({ "src/a.ts": "export const X = 1;\n" }, (base) => {
    // The synthetic consumer above is missing, so make it live.
    fs.mkdirSync(path.join(base, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "tests/use.ts"),
      "import { X } from '../src/a';\nvoid X;\n",
    );
    assert.equal(main(["--gate"], base, () => {}), 0, "clean tree stays green");
  });
});

test("the documented universe is the one actually walked", () => {
  // The include set is the whole game; these are asserted rather than trusted
  // so a future edit to the once-missed extensions fails here.
  for (const ext of [".mjs", ".js", ".cjs", ".ts", ".tsx", ".mts"]) {
    assert.ok(REFERENCE_EXTENSIONS.includes(ext), `universe misses ${ext}`);
  }
  assert.ok(REFERENCE_ROOTS.includes("scripts"), "universe misses scripts/");
  assert.ok(REFERENCE_ROOTS.includes("tests"), "universe misses tests/");
  assert.ok(REFERENCE_ROOTS.includes("e2e"), "universe misses e2e/");
  // The root's own files are walked too, and non-recursively: node_modules/ is
  // a directory and must not appear.
  const rootFiles = rootCodeFiles(REPO).map((file) => path.basename(file));
  assert.ok(rootFiles.includes("worker.ts"), "universe misses the worker");
  assert.ok(
    !rootFiles.some((name) => name === "node_modules" || name.startsWith(".")),
    `root walk picked up a directory: ${rootFiles.join(", ")}`,
  );
});

test("the measured noise floor on this repository is zero", () => {
  // This is the gate half of #350. The classifier's false-positive floor was
  // measured on this tree (value exports with only in-file uses were removed by
  // #349/#354/#355/#357); it is zero, so a new zero-reference value export is a
  // deliberate decision to surface, not noise. If a genuinely public export
  // lands, this is where it is named — not a silent allowance list.
  const findings = scanRepository(REPO);
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.name}`),
    [],
    `zero-reference value exports in src/: ${formatReport(findings)}`,
  );
});

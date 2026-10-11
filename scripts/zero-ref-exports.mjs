/**
 * Zero-reference export guard (#350).
 *
 * The dead-code sweep (#349) removed five `export` keywords from symbols whose
 * only consumer was their own module. It was done by hand, and the two people
 * who ran the scan hit the *same* false signal in opposite directions, because
 * neither the symbol test nor the include set was written down:
 *
 *   - a basename scan reported ten live components, matching filenames instead
 *     of the extensionless module names the imports actually use;
 *   - a `.ts/.tsx/.mts`-only text scan reported MASTER_SHA256_PATTERN as dead,
 *     missing its five call sites in two `scripts/*.mjs` ops scripts.
 *
 * The lesson is that a reference count is only as good as *what it read*, so
 * the universe is the load-bearing part of this module and is declared here in
 * one place (REFERENCE_ROOTS / REFERENCE_EXTENSIONS) rather than spelled into
 * a grep. A test (tests/zero-ref-exports.test.mts) drives the classifier.
 *
 * It is a classifier, not a counter. Measured on this repo:
 *
 *   value export, zero references anywhere ......... the target, report it
 *   type export (type/interface alias) ............. out of scope, never read
 *   value export consumed only by scripts/*.mjs .... live, universe includes it
 *   Next.js entry file (page/layout/route/...) ..... framework consumer, skipped
 *
 * Types are out of scope by construction: ~75 type exports are used only as
 * in-file return/parameter types, which is a module's public shape and not
 * dead code. Excluding the whole kind, rather than allowlisting 75 names, is
 * the design decision — an allowlist would rot the day a name changes.
 *
 * References are collected from the AST (identifier nodes), never by grepping
 * raw text, so a name inside a string, template or comment does not count as a
 * consumer. The direction of error is deliberate: a name reused as an unrelated
 * local binding in another file reads as "still referenced", which can hide a
 * dead export but can never red a live one.
 *
 * The gate lives in tests/zero-ref-exports.test.mts, which runs on every test
 * run and asserts this repo's floor is still zero. This CLI stays report-only
 * (exit 0) so it is safe to run by hand for a read; `--gate` exits non-zero on
 * findings and exists for the day the check moves into its own CI step.
 *
 *   node scripts/zero-ref-exports.mjs            # report, exit 0
 *   node scripts/zero-ref-exports.mjs --gate     # report, exit 1 on findings
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.join(import.meta.dirname, "..");

/**
 * The include set is the whole game (#350): every directory an exported symbol
 * can be consumed from. `scripts/` is here because MASTER_SHA256_PATTERN is used
 * only from `.mjs` ops scripts; a src-only universe would have called it dead.
 */
export const REFERENCE_ROOTS = ["src", "tests", "e2e", "scripts"];

/**
 * Every extension actually in play. `.mjs`/`.js` once missed a real consumer;
 * `.cjs` is here because a script that switched to it would fall out silently.
 */
export const REFERENCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs"];

/**
 * Declaring scope is narrower than the reference universe: the acceptance
 * criterion is "a value export added to src/". Dead exports in the ops scripts
 * are not this guard's job.
 */
export const DECLARING_ROOT = "src";

/**
 * Next.js consumes these files by *location and export name*, not by importing
 * them: `page.tsx`'s default and a route's `GET`/`dynamic`/`runtime` have no
 * importer in the tree. They are entry points with a framework consumer, so
 * their exports are skipped. Matched by basename anywhere under src/ — a
 * `route.ts` only means something to Next when it sits in the route tree, and
 * a same-named file elsewhere is not a module we want to guard anyway.
 */
export const FRAMEWORK_ENTRY_FILES = new Set([
  "page",
  "layout",
  "template",
  "route",
  "loading",
  "error",
  "global-error",
  "not-found",
  "default",
  "sitemap",
  "robots",
  "manifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
  "middleware",
  "instrumentation",
]);

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TS;
}

/** Recursively every code file under `dir`, in the given extensions. */
export function sourceFiles(dir, extensions = REFERENCE_EXTENSIONS) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full, extensions));
    } else if (
      extensions.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function isFrameworkEntry(file) {
  return FRAMEWORK_ENTRY_FILES.has(path.basename(file).replace(/\.[^.]+$/, ""));
}

function hasModifier(node, kind) {
  return (node.modifiers ?? []).some((m) => m.kind === kind);
}

/** Every name a binding pattern introduces, so `export const { a, b } = x` counts both. */
function bindingNames(name, out) {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
}

/**
 * The value exports of one parsed file: `const`/`let`/`var`, function, class,
 * enum, and the non-type entries of a local `export { a, b }`.
 *
 * Deliberately absent: `export default` (no stable name to reference; the
 * module path is the contract), `export ... from` re-exports (the declaring
 * module owns the symbol, and it is the one that gets reported), `export *`,
 * and everything type-only. A named re-export with `from` is someone else's
 * surface; reporting it here would name the wrong file.
 */
export function valueExports(source) {
  const found = [];
  const lineOf = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  for (const statement of source.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;

    if (
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
    ) {
      for (const decl of statement.declarationList.declarations) {
        const names = [];
        bindingNames(decl.name, names);
        for (const name of names) {
          found.push({ name, line: lineOf(decl), kind: "value" });
        }
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      statement.name
    ) {
      found.push({ name: statement.name.text, line: lineOf(statement), kind: "value" });
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const spec of statement.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        found.push({ name: spec.name.text, line: lineOf(spec), kind: "value" });
      }
    }
  }
  return found;
}

/** Every identifier the AST contains: a real use, not a match inside text. */
export function identifierNames(source) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/**
 * The classifier. Given a declaring scope and a reference universe, return the
 * value exports that no file outside their own module names. Pure over its
 * inputs so the test can drive it with a synthetic tree; `scanRepository` is
 * the filesystem wrapper.
 */
export function findZeroReferenceExports({ declaringFiles, universeFiles, readFile }) {
  const references = new Map();
  for (const file of universeFiles) {
    references.set(file, identifierNames(parse(file, readFile(file))));
  }

  const findings = [];
  for (const file of declaringFiles) {
    for (const { name, line, kind } of valueExports(parse(file, readFile(file)))) {
      let referenced = false;
      for (const [other, names] of references) {
        if (other !== file && names.has(name)) {
          referenced = true;
          break;
        }
      }
      if (!referenced) findings.push({ file, name, line, kind });
    }
  }
  return findings;
}

/** Walk the real tree and classify. Paths in the result are repo-relative. */
export function scanRepository(base = root) {
  const exists = (dir) => fs.existsSync(path.join(base, dir));
  const universeFiles = REFERENCE_ROOTS.filter(exists).flatMap((dir) =>
    sourceFiles(path.join(base, dir)),
  );
  const declaringFiles = sourceFiles(path.join(base, DECLARING_ROOT)).filter(
    (file) => !isFrameworkEntry(file),
  );
  const readFile = (file) => fs.readFileSync(file, "utf8");
  return findZeroReferenceExports({ declaringFiles, universeFiles, readFile }).map(
    (finding) => ({ ...finding, file: path.relative(base, finding.file) }),
  );
}

export function formatReport(findings) {
  if (findings.length === 0) {
    return "zero-ref-exports: no zero-reference value exports in src/";
  }
  const lines = [
    `zero-ref-exports: ${findings.length} value export(s) with no reference outside their module`,
  ];
  for (const { file, line, name } of findings) {
    lines.push(`  ${file}:${line}  ${name}`);
  }
  return lines.join("\n");
}

export function main(
  argv = process.argv.slice(2),
  base = root,
  write = (text) => process.stdout.write(text),
) {
  const gate = argv.includes("--gate");
  const findings = scanRepository(base);
  write(`${formatReport(findings)}\n`);
  return gate && findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main());
}

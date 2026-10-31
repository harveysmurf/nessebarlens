/**
 * The exported surface of the modules whose dead type exports were removed.
 *
 * `ParsedJsonBody`, `CheckoutBody` and `QuoteBody` were each exported from the
 * module that declares them and imported by name from nowhere: consumers call
 * the parser and let inference give them the shape. An exported type with no
 * importer is dead surface — a name the module advertises and nothing uses.
 *
 * The zero-reference export guard (`scripts/zero-ref-exports.mjs`) cannot see
 * this. It classifies *value* exports, and a type alias is deliberately out of
 * scope there, because a type used only as its own module's return type is a
 * module's public shape rather than dead code. That boundary is right for the
 * ~75 type exports in `src/`, and it is why these three needed a check of
 * their own.
 *
 * So this reads the surface the way a consumer sees it: the names the
 * TypeScript compiler will let another module import. A type that is not
 * exported cannot be named from outside, and the assertions below are about
 * that fact — not about the text of the file. A comment cannot satisfy them
 * and a rename cannot survive them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const REPO = path.join(import.meta.dirname, "..");

const CHECKOUT_BODY = path.join(REPO, "src/domain/ordering/checkout-body.ts");
const JSON_BODY = path.join(REPO, "src/infrastructure/config/json-body.ts");

/**
 * The names each given file exports, as the compiler sees them — values and
 * types alike.
 *
 * The program is scoped to the files under test and does not resolve imports
 * (`noResolve`): what is read here is a module's own export declarations, not
 * the types they refer to. Nothing in this check needs the dependency graph,
 * and resolving it would turn a two-file check into a whole-repo program.
 */
function exportedSurface(files: string[]): Map<string, string[]> {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noResolve: true,
  });
  const checker = program.getTypeChecker();
  const surface = new Map<string, string[]>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source, `could not load ${file}`);
    const symbol = checker.getSymbolAtLocation(source);
    assert.ok(symbol, `no module symbol for ${file}`);
    surface.set(
      file,
      checker
        .getExportsOfModule(symbol)
        .map((exported) => exported.getName())
        .sort(),
    );
  }
  return surface;
}

/** The exported names of one file, or a failure if it could not be read. */
function exportsOf(file: string): string[] {
  const names = exportedSurface([file]).get(file);
  assert.ok(names, `no surface for ${file}`);
  return names;
}

test("a type export is seen by the surface reader", () => {
  // The control for the negative assertions below: a reader that never sees an
  // export would make "this is not exported" true of everything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "module-surface-"));
  try {
    const file = path.join(dir, "shape.ts");
    fs.writeFileSync(
      file,
      "export type Shape = { a: number };\nexport function make(): Shape {\n  return { a: 1 };\n}\n",
    );
    assert.deepEqual(exportsOf(file), ["Shape", "make"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the checkout body module exports its parsers, not the types they return", () => {
  const names = exportsOf(CHECKOUT_BODY);

  // The parsers are the surface: the quote and checkout routes call them.
  assert.ok(
    names.includes("parseCheckoutBody"),
    `parseCheckoutBody is not exported: ${names.join(", ")}`,
  );
  assert.ok(
    names.includes("parseQuoteBody"),
    `parseQuoteBody is not exported: ${names.join(", ")}`,
  );

  // The body types are not: no module names them, so exporting them only
  // advertised a shape nobody imports.
  assert.ok(
    !names.includes("CheckoutBody"),
    "CheckoutBody is exported but no consumer names it",
  );
  assert.ok(!names.includes("QuoteBody"), "QuoteBody is exported but no consumer names it");
  assert.ok(
    !names.includes("DigitalCheckout"),
    "DigitalCheckout is exported but no consumer names it",
  );
  assert.ok(
    !names.includes("PhysicalCheckout"),
    "PhysicalCheckout is exported but no consumer names it",
  );
});

test("the json body module exports its reader, not the type it returns", () => {
  const names = exportsOf(JSON_BODY);

  assert.ok(
    names.includes("readJsonBody"),
    `readJsonBody is not exported: ${names.join(", ")}`,
  );
  assert.ok(
    !names.includes("ParsedJsonBody"),
    "ParsedJsonBody is exported but no consumer names it",
  );
});

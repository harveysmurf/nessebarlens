/**
 * One source of truth per grammar and per shape.
 *
 * Two separate bugs in this repo were the same bug: a grammar or a storage
 * shape was declared once correctly and then re-declared by a second module
 * that stayed behaviourally identical until it didn't. Neither was caught by a
 * test, because the copies agreed. So "we have tests" is not the invariant —
 * "there is exactly one place this is written down" is.
 *
 * This walks the AST rather than grepping, so a regex inside a string or a
 * comment is not mistaken for a declaration.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { filmLookClass } from "../src/lib/photos.ts";

const root = path.join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

type Declared = { file: string; line: number };

function relative(file: string): string {
  return path.relative(root, file);
}

/** Every regex literal in the tree, as `file:line` occurrences of its source. */
function regexLiterals(): Map<string, Declared[]> {
  const bySource = new Map<string, Declared[]>();
  for (const file of sourceFiles(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isRegularExpressionLiteral(node)) {
        // getText(), not .text: the latter drops the delimiters, so a regex and
      // the string literal "/…/" would key identically.
      const key = node.getText(source);
        const list = bySource.get(key) ?? [];
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        list.push({ file: relative(file), line: line + 1 });
        bySource.set(key, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bySource;
}

/** Object type literals and interfaces, by declared name. */
function shapeDeclarations(): Map<string, Declared[]> {
  const byName = new Map<string, Declared[]>();
  const record = (name: string, file: string, line: number): void => {
    const list = byName.get(name) ?? [];
    list.push({ file: relative(file), line });
    byName.set(name, list);
  };
  for (const file of sourceFiles(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isTypeAliasDeclaration(node) &&
          ts.isTypeLiteralNode(node.type)) ||
        ts.isInterfaceDeclaration(node)
      ) {
        const name = node.name.text;
        record(name, file, lineOf(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return byName;
}

test("no regex literal is written down in two modules", () => {
  const duplicates: string[] = [];
  for (const [source, sites] of regexLiterals()) {
    const files = new Set(sites.map((s) => s.file));
    if (files.size > 1) {
      duplicates.push(
        `${source} in ${[...files].join(", ")} (${sites
          .map((s) => `${s.file}:${s.line}`)
          .join(", ")})`,
      );
    }
  }
  assert.deepEqual(duplicates, []);
});

test("the owned grammars are declared exactly once, in their owning module", () => {
  // Spelled out rather than derived: these are the grammars that already grew
  // a divergent copy once. A new copy fails here even if it is, today,
  // behaviourally identical — which is exactly the case tests missed.
  const owners: Record<string, string> = {
    "/^[a-z0-9]+(?:-[a-z0-9]+)*$/": "src/lib/master-key.ts",
    "/prints\\/|nessebar-lens-masters/i": "src/lib/master-guard.ts",
    "/^[0-9a-f]{64}$/i": "src/lib/crypto-hex.ts",
    "/^[A-Z]{2}$/": "src/lib/ship-to-countries.ts",
    "/^https:\\/\\//i": "src/lib/url-patterns.ts",
  };
  const found = regexLiterals();
  for (const [source, owner] of Object.entries(owners)) {
    const sites = found.get(source) ?? [];
    assert.equal(sites.length, 1, `${source} declared ${sites.length} times`);
    assert.equal(sites[0]!.file, owner, `${source} owned by ${sites[0]!.file}`);
  }
});

test("the master-marker and slug grammars are still single modules", () => {
  // The converse of the check above, so a renamed or rewritten grammar cannot
  // quietly fall out of the registry above and stop being guarded.
  const bySource = regexLiterals();
  const markerSites = bySource.get("/prints\\/|nessebar-lens-masters/i") ?? [];
  assert.equal(markerSites.length, 1, "master marker duplicated");
  const slugSites = bySource.get("/^[a-z0-9]+(?:-[a-z0-9]+)*$/") ?? [];
  assert.equal(slugSites.length, 1, "slug pattern duplicated");
});

test("no object shape is declared in two modules", () => {
  const duplicates: string[] = [];
  for (const [name, sites] of shapeDeclarations()) {
    const files = new Set(sites.map((s) => s.file));
    if (files.size > 1) {
      duplicates.push(
        `${name} in ${[...files].join(", ")} (${sites
          .map((s) => `${s.file}:${s.line}`)
          .join(", ")})`,
      );
    }
  }
  assert.deepEqual(duplicates, []);
});

test("the film-look filter class is not re-spelled in any tsx file", () => {
  // Same bug shape as the grammars above: the class was hand-rolled in every
  // page and component, and the copies agreed until one of them didn't. A
  // behavioural test could not catch it, because before the rename every copy
  // was correct. This is the source walk that can.
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    if (!file.endsWith(".tsx")) continue;
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && node.text.includes("contrast-125")) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        offenders.push(`${relative(file)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, [], `filter contrast-125 re-spelled in tsx: ${offenders.join(", ")}`);
});

test("filmLookClass is the single source of every film-look class", () => {
  assert.equal(filmLookClass("contrast"), "filter contrast-125");
  assert.equal(filmLookClass("sepia"), "filter sepia");
  assert.equal(filmLookClass("grayscale"), "filter grayscale");
  assert.equal(filmLookClass(undefined), "");
});

test("the MASTERS storage shape is declared once and both readers import it", () => {
  const shapes = shapeDeclarations();
  for (const name of ["MastersBucket", "MasterObject"]) {
    const sites = shapes.get(name) ?? [];
    assert.equal(sites.length, 1, `${name} declared ${sites.length} times`);
    assert.equal(sites[0]!.file, "src/lib/master-key.ts", name);
  }
  for (const reader of ["src/lib/fulfillment.ts", "src/lib/print-asset.ts"]) {
    const src = fs.readFileSync(path.join(root, reader), "utf8");
    assert.match(src, /from "\.\/master-key"/, reader);
  }
});

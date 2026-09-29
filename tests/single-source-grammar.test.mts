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
import { FILM_LOOKS, filmLookClass } from "../src/lib/photos.ts";

const root = path.join(import.meta.dirname, "..");

// Both lists are the module's own runtime exports, not spellings of them: a
// new look added to FILM_LOOKS is walked the day it is added, instead of only
// once someone remembers to edit this file too.
const FILM_LOOK_CLASSES: string[] = FILM_LOOKS.map((look) => {
  const cls = filmLookClass(look);
  // If a look stopped mapping to a class, the walk below would quietly stop
  // guarding that look instead of failing, so assert the input is usable.
  // Truthiness, not notEqual: a look that stopped mapping returns undefined,
  // and includes(undefined) silently stops matching rather than failing.
  assert.ok(cls, `${look} maps to no class; the walk would be vacuous for it`);
  return cls;
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(tsx?|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

type Declared = { file: string; line: number };

function relative(file: string): string {
  return path.relative(root, file);
}

/**
 * src/ and scripts/ together. The ops scripts are excluded for no reason
 * other than that they used to be: an ingest script that re-inlines the
 * ladder flag's `true|1` grammar would refuse runs the site is serving from,
 * and no src-only test can see that.
 */
function allSourceFiles(): string[] {
  return [
    ...sourceFiles(path.join(root, "src")),
    ...sourceFiles(path.join(root, "scripts")),
  ];
}

/** Every regex literal in the tree, as `file:line` occurrences of its source. */
function regexLiterals(): Map<string, Declared[]> {
  const bySource = new Map<string, Declared[]>();
  for (const file of allSourceFiles()) {
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
  for (const file of allSourceFiles()) {
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
    // Owned by derivative-ladder.ts, not master-key.ts: the leaf module with
    // no imports is the one an ops script can load, so the grammar it needs
    // has to live there. master-key.ts re-exports it.
    "/^[a-z0-9]+(?:-[a-z0-9]+)*$/": "src/lib/derivative-ladder.ts",
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

test("a film-look class is not re-spelled outside its owning module", () => {
  // Same bug shape as the grammars above: the class was hand-rolled in every
  // page and component, and the copies agreed until one of them didn't. A
  // behavioural test could not catch it, because before the rename every copy
  // was correct. This is the source walk that can.
  //
  // All three classes, not just contrast: sepia and grayscale were duplicated
  // in the same two files, and a guard that covers only the instance you
  // happened to notice does not guard the class of bug.
  const OWNER = "src/lib/photos.ts";
  const owners: string[] = [];
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const rel = relative(file);
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) {
        const look = FILM_LOOK_CLASSES.find((cls) => node.text.includes(cls));
        if (look) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          (rel === OWNER ? owners : offenders).push(`${look} at ${rel}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    offenders,
    [],
    `film-look class declared outside ${OWNER}: ${offenders.join(", ")}`,
  );
  // The owner must still declare all three, or the walk above is vacuous
  // because someone emptied the record.
  for (const cls of FILM_LOOK_CLASSES) {
    assert.ok(
      owners.some((o) => o.startsWith(cls)),
      `${cls} not declared in ${OWNER}`,
    );
  }
});

test("filmLookClass maps every look in the union, and nothing else", () => {
  for (const look of FILM_LOOKS) {
    assert.notEqual(filmLookClass(look), "", look);
  }
  // Exact classes, not just non-empty: a Tailwind class that does not exist
  // renders as no filter at all, and the source walk would still be happy.
  assert.deepEqual(filmLookClass("contrast"), "filter contrast-125");
  assert.deepEqual(filmLookClass("sepia"), "filter sepia");
  assert.deepEqual(filmLookClass("grayscale"), "filter grayscale");
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

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
import { MASTERS_BUCKET_NAME } from "../src/lib/derivative-ladder.ts";
import { MASTERS_BUCKET, MASTER_MARKER } from "../src/lib/master-guard.ts";
import { FILM_LOOKS, filmLookClass } from "../src/lib/photos.ts";
import { AWAITING_PRODIGI_REASON } from "../src/lib/fulfillment.ts";

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

/** Its own type rather than an optional field on Declared, which the regex and shape walks never carry. */
type LiteralSite = { file: string; line: number; literal: string };

/** Every string literal in src/, as `file:line`, from the AST rather than a grep. */
function stringLiteralSites(): LiteralSite[] {
  const sites: LiteralSite[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        sites.push({ literal: node.text, file: relative(file), line: line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
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
  const slugSites = bySource.get("/^[a-z0-9]+(?:-[a-z0-9]+)*$/") ?? [];
  assert.equal(slugSites.length, 1, "slug pattern duplicated");
});

test("the master marker tracks the bucket name instead of re-spelling it", () => {
  // The marker used to hardcode the bucket as a regex literal. Renaming the
  // bucket would then have left the guard matching a name that no longer
  // exists — a silent leak, with the grammar test still green because it only
  // pinned "declared once". Tie the two together instead.
  assert.equal(MASTERS_BUCKET, MASTERS_BUCKET_NAME);
  assert.ok(
    MASTER_MARKER.source.includes(MASTERS_BUCKET_NAME),
    `master marker does not reference ${MASTERS_BUCKET_NAME}: ${MASTER_MARKER.source}`,
  );
  assert.ok(MASTER_MARKER.test(MASTERS_BUCKET_NAME), "marker rejects the bucket");
  assert.ok(MASTER_MARKER.test("prints/dusk.jpg"), "marker rejects a master key");

  // And the name itself is written down once: a second copy in another module
  // is the drift this whole file exists to catch. Comments are excluded — the
  // other three hits are prose explaining the boundary, and a doc comment that
  // names the bucket correctly is not a second declaration of it.
  const declaring = allSourceFiles().filter((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some(
        (line) =>
          !line.trim().startsWith("*") &&
          !line.trim().startsWith("//") &&
          line.includes(MASTERS_BUCKET_NAME),
      ),
  );
  assert.deepEqual(
    declaring.map(relative).sort(),
    ["src/lib/derivative-ladder.ts"],
    "masters bucket name spelled outside derivative-ladder.ts",
  );
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

test("filmLookClass is never called with a spelled-out look name", () => {
  // The class-name walk above cannot see a bare look name: filmLookClass("contrast")
  // is not the class, it is the key. Two category cards once passed the literal
  // behind a hand-maintained `contrast: true` flag, so renaming a look in
  // FILM_LOOKS would have left those two pages asking for a look that no longer
  // exists — rendering no filter at all — with the source walk still green.
  // The only legal argument is photo.filmLook.
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    if (relative(file) === "src/lib/photos.ts") {
      // The owner: FILM_LOOK_CLASS's keys are the legal spellings, and a
      // non-literal there is a compile error, not a duplication.
      continue;
    }
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "filmLookClass"
      ) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          offenders.push(`${relative(file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    offenders,
    [],
    `filmLookClass called with a look name literal: ${offenders.join(", ")}`,
  );
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

test("no module re-exports a single-source constant under a second name", () => {
  // prodigi-quote.ts used to export DEFAULT_DESTINATION_COUNTRY as a
  // second name for DEFAULT_SHIPPING_COUNTRY, used nowhere else. A behavioural
  // test cannot catch an alias — the two names agreed perfectly until one of
  // them was changed. This walks the AST for the two declaration shapes an
  // alias can take: `export const X = SOME_CONST` and
  // `export { SOME_CONST as X }`.
  const GUARDED: Record<string, string> = {
    DEFAULT_SHIPPING_COUNTRY: "src/lib/ship-to-countries.ts",
  };
  const offenders: string[] = [];
  for (const file of allSourceFiles()) {
    const rel = relative(file);
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
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of node.declarationList.declarations) {
          if (
            decl.initializer &&
            ts.isIdentifier(decl.initializer) &&
            GUARDED[decl.initializer.text]
          ) {
            offenders.push(
              `${decl.name.getText()} = ${decl.initializer.text} at ${rel}:${lineOf(decl)}`,
            );
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.exportClause &&
          ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          const local = (spec.propertyName ?? spec.name).text;
          if (spec.name.text !== local && GUARDED[local]) {
            offenders.push(
              `${spec.name.text} = ${local} at ${rel}:${lineOf(spec)}`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, [], `constant aliased: ${offenders.join(", ")}`);
  // Non-vacuous: the constants above must still exist in their owning module,
  // or this walk stops guarding anything while staying green.
  for (const [name, owner] of Object.entries(GUARDED)) {
    const src = fs.readFileSync(path.join(root, owner), "utf8");
    assert.match(src, new RegExp(`export const ${name}\\b`), name);
  }
});

test("the awaiting-prodigi reason marker is spelled once, in fulfillment.ts", () => {
  // `reason` is `string | null`, so a one-sided rename of this marker
  // type-checks: the writer keeps writing one spelling and the Prodigi
  // trigger keeps comparing against another, and every paid print is then
  // stuck at paid-unfulfilled with no log line anywhere. A behavioural test
  // cannot see that — before the drift both sides are correct — so pin the
  // spelling itself: exactly one literal in src/, and it is the one the
  // constant holds.
  const OWNER = "src/lib/fulfillment.ts";
  // Imported, not re-typed: the guard has to track whatever the constant is
  // called now, and a hand-written name here would drift into a test that
  // passes because it guarded a spelling nobody uses.
  const VALUE = AWAITING_PRODIGI_REASON;
  const NAME = `${VALUE.toUpperCase().replaceAll("-", "_")}_REASON`;
  // The walk keys off the identifier, so the two must be the same word in the
  // two spellings. Asserted rather than assumed: if the value is ever renamed
  // without the name following, this fails here instead of quietly finding
  // zero uses and calling that a pass.
  assert.equal(NAME, "AWAITING_PRODIGI_REASON");
  const sites: string[] = [];
  const uses: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const rel = relative(file);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === VALUE
      ) {
        sites.push(`${rel}:${lineOf(node)}`);
      }
      if (ts.isIdentifier(node) && node.text === NAME) {
        // The declaration's own name node is not a use.
        const parent = node.parent;
        const isDeclName =
          parent &&
          ts.isVariableDeclaration(parent) &&
          parent.name === node;
        if (!isDeclName) {
          uses.push(`${rel}:${lineOf(node)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Non-vacuous in both directions: the literal must exist exactly once, in
  // the owner, and both the writer and the reader must reference the
  // constant. Zero literals would mean the constant is not the marker's
  // value; a single use would mean one of the two sides was inlined again.
  assert.deepEqual(
    sites.map((s) => s.split(":")[0]),
    [OWNER],
    `"awaiting-prodigi" spelled outside ${OWNER}: ${sites.join(", ")}`,
  );
  const owned = uses.filter((u) => u.startsWith(`${OWNER}:`));
  assert.ok(
    owned.length >= 2,
    `expected the writer and the reader to use ${NAME}, saw ${owned.length}`,
  );
});

test("the two body rejections stay one literal each, and stay different", () => {
  const sites = stringLiteralSites();
  const at = (literal: string) => sites.filter((s) => s.literal === literal);

  // A body that parsed to a number or a string: one declaration, in the module
  // that owns both parsers. A re-inline in the other parser fails here.
  assert.deepEqual(
    at("Invalid JSON body").map((s) => s.file),
    ["src/lib/checkout-body.ts"],
  );

  // A body that would not parse at all is a different rejection and a different
  // string, deliberately: unifying the two would tell the caller nothing about
  // which of the two happened.
  assert.deepEqual(
    at("Invalid JSON").map((s) => s.file),
    ["src/lib/json-body.ts"],
  );
});

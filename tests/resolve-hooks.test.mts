import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = path.join(import.meta.dirname, "..", "src");

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("the resolve hook is the only thing in the loader chain", async () => {
  const hooks = await readFile(
    path.join(import.meta.dirname, "..", "scripts", "resolve-hooks.mjs"),
    "utf8",
  );
  // Comment text is allowed to mention the old approach; code is not. A
  // transpiler here is what needed a source map to report sane line numbers,
  // and node strips types itself now, so there is nothing to compile.
  const code = hooks
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(code.includes("export async function resolve"), true);
  assert.equal(code.includes("transpile"), false);
  assert.equal(code.includes("typescript"), false);
  assert.equal(code.includes("export async function load"), false);
});

test("a relative import specifier inside a string literal is never rewritten", async () => {
  // The bug this guards: a regex rewrite over transpiled output turned this
  // literal's specifier into "./pricing.ts", so a source-grep guard failed for
  // a reason unrelated to the code under test. Nothing rewrites text now, so
  // the needle a guard holds has to match the file on disk verbatim.
  const quote = await readFile(path.join(SRC, "infrastructure/prodigi/prodigi-quote.ts"), "utf8");
  assert.equal(quote.includes(`from "../../domain/pricing/pricing"`), true);
  assert.equal(quote.includes(`from "../../domain/pricing/pricing.ts"`), false);
});

test("the extensionless specifier the resolve hook exists for still resolves", async () => {
  const fulfillment = await readFile(
    path.join(SRC, "application/fulfillment/fulfillment.ts"),
    "utf8",
  );
  assert.equal(
    fulfillment.includes(`from "../../domain/pricing/pricing"`),
    true,
    "source keeps the extensionless specifier",
  );
  const pricing = await import("../src/domain/pricing/pricing.ts");
  assert.equal(typeof pricing.PRODIGI_MARGIN, "number");
});

test("every src file is erasable-syntax only, so node can strip it itself", async () => {
  // every src file is erasable-syntax only, so node can strip it itself. (TypeScript compiles
  // enums, namespaces and constructor parameter properties, which node's type stripping refuses
  // at runtime.) Nothing in the suite imports from app/ or components/ yet, so tsc is not a
  // guarantee for those files — this is.
  const banned = [
    [/^\s*export\s+(const\s+)?enum\s/m, "enum"],
    [/^\s*(export\s+)?namespace\s/m, "namespace"],
    [/^\s*declare\s+module\s/m, "declare module"],
  ];
  const offenders = [];
  for (const file of await sourceFiles(SRC)) {
    const text = await readFile(file, "utf8");
    for (const [pattern, label] of banned) {
      if (pattern.test(text)) offenders.push(`${path.relative(SRC, file)}: ${label}`);
    }
  }
  assert.deepEqual(offenders, []);
});

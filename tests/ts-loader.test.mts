import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const LOADER = path.join(import.meta.dirname, "ts-loader.mjs");
const PRICING = path.join(import.meta.dirname, "..", "src/lib/pricing.ts");
const FULFILLMENT = path.join(
  import.meta.dirname,
  "..",
  "src/lib/fulfillment.ts",
);
const PRODIGI_QUOTE = path.join(
  import.meta.dirname,
  "..",
  "src/lib/prodigi-quote.ts",
);

/** Transpile the same way the loader does, with no text rewriting. */
async function transpile(file) {
  const source = await readFile(file, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
}

test("ts-loader no longer rewrites source text", async () => {
  const loader = await readFile(LOADER, "utf8");
  assert.equal(
    /outputText\.replace\(/.test(loader),
    false,
    "the loader must not post-process transpiled output",
  );
  assert.equal(loader.includes(".replace("), false);
  assert.equal(loader.includes("export async function resolve"), true);
});

test("relative import specifiers inside string literals survive verbatim", async () => {
  // This is the bug: the old regex-based rewrite turned this literal's
  // "./pricing" into "./pricing.ts", so a source-grep guard failed for a
  // reason unrelated to the code under test. Transpile a real file that
  // imports pricing for a value (type-only imports are elided by transpile).
  const skuMap = await transpile(PRODIGI_QUOTE);
  assert.equal(
    skuMap.includes(`from "${"."}/pricing"`),
    true,
    "the specifier inside the import must be untouched",
  );
  assert.equal(skuMap.includes(`from "${"."}/pricing.ts"`), false);

  // The needle that previously broke, as a literal a guard might hold.
  const guardNeedle = `from "${"."}/pricing"`;
  assert.equal(
    skuMap.includes(guardNeedle),
    true,
    "a source-grep needle must match the untouched specifier",
  );
});

test("the real import statement still gets its extension resolved at load time", async () => {
  // The rewrite is gone, so the source keeps the extensionless specifier;
  // the resolve hook is what makes it work. Prove both halves.
  const fulfillment = await readFile(FULFILLMENT, "utf8");
  assert.equal(
    fulfillment.includes(`from "${"."}/pricing"`),
    true,
    "source keeps the extensionless specifier",
  );
  // And the module actually loads through that specifier.
  const pricing = await import("../src/lib/pricing.ts");
  assert.equal(typeof pricing.PRODIGI_MARGIN, "number");
});

test("a string literal that looks like a from-clause is not mistaken for an import", async () => {
  const pricing = await transpile(PRICING);
  // pricing.ts has no imports at all; nothing may be injected.
  assert.equal(pricing.includes(".ts\""), false);
});

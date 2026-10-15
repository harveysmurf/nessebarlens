/**
 * The Worker env key list is linked to the generated type (#401).
 *
 * `config/env.ts` names the six bindings in `WorkerEnvShape` by hand. That is
 * what lets the Node-facing tsconfig compile the app without
 * `@cloudflare/workers-types` in the program at all — the package declares
 * `var process: any` and `var Buffer: any` as globals, so any program that
 * includes it has every `process.env` unchecked. The price of leaving it out is
 * a second, hand-written list of the same keys, and a second list is a list that
 * drifts: add a bucket to `wrangler.toml`, regenerate, and `env.ORDERS_DB` would
 * still compile here while the platform never bound it.
 *
 * So this reads both sides and fails if they differ. The generated side is
 * parsed from the AST rather than regexed, for the reason
 * `tests/single-source-grammar.test.mts` gives — a comment in that file
 * discusses this exact trade by name, and a text scan would flag the
 * documentation of the rule as a breach of it. The hand-written side is read
 * through the checker, because a type's property list is not observable at
 * runtime and inventing a runtime shape for it would test the invention.
 *
 * This is the same shape of gate as `tests/tsconfig-gate.test.mts`: a list that
 * can silently stop matching is worse than no list, because it reads as
 * coverage.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.join(import.meta.dirname, "..");
const GENERATED = path.join(root, "cloudflare-env.d.ts");
const ENV_MODULE = path.join(root, "src", "infrastructure", "config", "env.ts");

/** The keys wrangler generated for the production env, from the file's AST. */
function generatedEnvKeys(): string[] {
  const source = ts.createSourceFile(
    GENERATED,
    fs.readFileSync(GENERATED, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  // Collected into a plain array rather than assigned to a `string[] | null`
  // that is then narrowed: the assignment happens inside the walk, and
  // control-flow analysis does not follow a closure, so the narrowing produced
  // `never` and the file only type-checked in the program that excludes tests.
  const keys: string[] = [];
  let sawInterface = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === "__BaseEnv_CloudflareEnv"
    ) {
      sawInterface = true;
      for (const m of node.members) {
        if (ts.isPropertySignature(m)) keys.push(m.name.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(sawInterface, "cloudflare-env.d.ts no longer declares __BaseEnv_CloudflareEnv");
  return keys.sort();
}

/** The keys `WorkerEnvShape` declares, read through the checker. */
function handWrittenEnvKeys(): string[] {
  // Built once. Building a program costs ~14s and two of these tests need the
  // same answer, so an unmemoized call doubled the file's runtime for nothing.
  handWrittenEnvKeysCache ??= readHandWrittenEnvKeys();
  return handWrittenEnvKeysCache;
}

let handWrittenEnvKeysCache: string[] | undefined;

function readHandWrittenEnvKeys(): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "tsconfig.json"),
    /* no command-line overrides */ {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
      },
    },
  );
  assert.ok(parsed, "tsconfig.json must parse");
  assert.ok(
    parsed.fileNames.includes(ENV_MODULE),
    "config/env.ts must be in the program whose types are being read",
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENV_MODULE);
  assert.ok(source, "config/env.ts must resolve to a source file");

  let alias: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!alias && ts.isTypeAliasDeclaration(node) && node.name.text === "WorkerEnvShape") {
      alias = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(alias, "config/env.ts must still declare WorkerEnvShape");
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(alias))
    .map((p) => p.name)
    .sort();
}

test("the hand-written env keys are the generated env keys", () => {
  const generated = generatedEnvKeys();
  const handWritten = handWrittenEnvKeys();
  assert.ok(generated.length > 0, "the generated list must not be empty");
  assert.deepEqual(
    handWritten,
    generated,
    "config/env.ts and cloudflare-env.d.ts disagree about the Worker's bindings",
  );
});

test("the env is not an open string map, or the key list checks nothing", () => {
  // The failure this whole arrangement risks: someone "simplifies" the six named
  // keys to an index signature, which compiles for every typo and turns the test
  // above into a comparison of a list against itself.
  const source = fs.readFileSync(ENV_MODULE, "utf8");
  const parsed = ts.createSourceFile(ENV_MODULE, source, ts.ScriptTarget.Latest, true);
  let hasIndexSignature = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "WorkerEnvShape" &&
      ts.isTypeLiteralNode(node.type)
    ) {
      hasIndexSignature = node.type.members.some(
        (m) => ts.isIndexSignatureDeclaration(m) && !m.parameters[0]?.dotDotDotToken,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(
    hasIndexSignature,
    false,
    "WorkerEnvShape grew an index signature: every key would compile and the list above would be vacuous",
  );
});

test("the binding-shaped WorkerBindings keys exist in the env shape", () => {
  // The other direction of the same linkage, and the one that catches a binding
  // being read but never declared. `WorkerBindings` names its derived fields in
  // camelCase (`webhookSecret`, `printAssetSecret`, …) because they are the
  // result of reading and validating, so only the pass-through binding keys are
  // comparable — and those are the ones that must not drift.
  const source = fs.readFileSync(
    path.join(root, "src", "infrastructure", "cloudflare", "worker-bindings.ts"),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "worker-bindings.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const passThrough: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "WorkerBindings" &&
      ts.isTypeLiteralNode(node.type)
    ) {
      for (const m of node.type.members) {
        if (!ts.isPropertySignature(m)) continue;
        const name = m.name.getText(parsed);
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) passThrough.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(passThrough.length > 0, "expected at least one pass-through binding key");
  const envKeys = new Set(handWrittenEnvKeys());
  for (const key of passThrough) {
    assert.ok(envKeys.has(key), `WorkerBindings.${key} is not in the env shape`);
  }
});

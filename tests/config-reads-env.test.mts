/**
 * One place reads environment (#119).
 *
 * The AC is "env is read only in config.ts / env.ts / worker-bindings.ts", and
 * the reason it needs a test rather than a review habit: the failure it guards
 * against is *silent*. A module that reads process.env itself keeps working,
 * keeps passing every behavioural test, and merely re-creates the second
 * resolution path the refactor exists to delete. Nothing goes red until someone
 * changes an env var's handling in one copy.
 *
 * Walked on the AST. A grep cannot tell a `process.env` read from the word
 * "process.env" in a comment explaining why a read is safe, and this repo's
 * comments discuss exactly that string — the print-asset route's note about the
 * deleted `??` fallback is three lines from the deleted fallback.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.join(import.meta.dirname, "..");
const srcDir = path.join(root, "src");

/**
 * The allowlist, by module basename.
 *
 * env.ts is the reader itself (envString and friends end in a process.env
 * lookup by design). config.ts is the composition root. worker-bindings.ts
 * reads the Worker env asynchronously and hands it down.
 *
 * prodigi-config.ts is deliberately absent, and that is the whole point of the
 * second test below: it used to be here via `env = process.env` default
 * parameters, which made every Prodigi reader reachable with no argument —
 * so a caller could not tell from the call site whether it was configured.
 */
const ALLOWED = new Set(["env.ts", "config.ts", "worker-bindings.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The chain of member names on an expression, outermost last: `process.env`
 * reads as ["env", "process"], `env.PRODIGI_API_BASE` as ["PRODIGI_API_BASE",
 * "env"].
 */
function memberChain(expr: ts.Expression): string[] {
  if (ts.isPropertyAccessExpression(expr)) {
    return [...memberChain(expr.expression), expr.name.text];
  }
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    return [
      ...memberChain(expr.expression),
      ...(arg && ts.isStringLiteralLike(arg) ? [arg.text] : []),
    ];
  }
  return [];
}

type Offence = { file: string; line: number; what: string };

/**
 * A default parameter that is a call, or that touches process.env, outside the
 * allowlist.
 *
 * This is the shape note 2 was about. A default reading process.env directly
 * is caught by the member walk; a default calling a helper that returns it —
 * `env = defaultEnv()` — is not, because from this module the call is just a
 * name. So the rule is structural instead of lexical: outside the allowlist, a
 * parameter default may only be a literal. Object-literal defaults (`opts:
 * { ... } = {}`) and `undefined` still pass, because they read nothing.
 */
function defaultParameterOffences(): Offence[] {
  const offences: Offence[] = [];
  for (const file of sourceFiles(srcDir)) {
    if (ALLOWED.has(path.basename(file))) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (node: ts.Node, what: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      offences.push({ file: path.relative(root, file), line: line + 1, what });
    };
    const visit = (node: ts.Node): void => {
      const params =
        (ts.isFunctionDeclaration(node) && node.parameters) ||
        (ts.isMethodDeclaration(node) && node.parameters) ||
        (ts.isFunctionExpression(node) && node.parameters) ||
        (ts.isArrowFunction(node) && node.parameters) ||
        undefined;
      for (const param of params ?? []) {
        const init = param.initializer;
        if (init === undefined) continue;
        // A call is only an env read if it reads like one. `nowMs = Date.now()`
        // is a default that reaches the clock, which is a different question and
        // is allowed; `env = defaultEnv()` is the one this guards.
        const callee = ts.isCallExpression(init) ? init.expression : undefined;
        const looksLikeEnvRead =
          (callee !== undefined &&
            ts.isIdentifier(callee) &&
            /env/i.test(callee.text)) ||
          (callee !== undefined && ts.isPropertyAccessExpression(callee)
            ? /env/i.test(callee.name.text)
            : false);
        if (looksLikeEnvRead || memberChain(init).includes("env")) {
          report(init, `default parameter for "${param.name.getText()}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offences;
}

/**
 * Reads of environment outside the allowlist.
 *
 * Two shapes, and the second matters as much as the first: `envString("X")`
 * with no env argument is a process.env read wearing a helper — the same
 * back door a default parameter is. The two-argument form is NOT a violation:
 * prodigi-config.ts calls envString("PRODIGI_API_BASE", env) on purpose, which
 * is a pure function of what it was handed, and that is the shape Architect
 * ruled for. Both are matched on structure, not spelling — a comment explaining why a read is safe is not a read, and this
 * repo has comments that name process.env three lines from code that does not.
 */
function envReadOffences(): Offence[] {
  const offences: Offence[] = [];
  for (const file of sourceFiles(srcDir)) {
    if (ALLOWED.has(path.basename(file))) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (node: ts.Node, what: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      offences.push({
        file: path.relative(root, file),
        line: line + 1,
        what,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const chain = memberChain(node);
        const base = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          ? node.expression
          : undefined;
        const root = base && ts.isIdentifier(base) ? base.text : undefined;
        if (root === "process" && chain.includes("env")) report(node, "process.env");
      }

      // envString/envFlag take (name, env). A call with only the name leans on
      // envString's own `= process.env` default, which is the read, wherever it
      // is written.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^env(String|Flag|StringStrippedSlash)/.test(node.expression.text) &&
        node.arguments.length === 1
      ) {
        report(node, `${node.expression.text}(…) with no env argument`);
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offences;
}

test("only config.ts, env.ts and worker-bindings.ts read environment", () => {
  const offences = envReadOffences();
  assert.deepEqual(
    offences,
    [],
    `environment read outside the allowlist (${ALLOWED.size} modules):\n` +
      offences.map((o) => `  ${o.file}:${o.line} ${o.what}`).join("\n"),
  );
});

test("the walk is not vacuous — prodigi-config.ts has no default env parameter", () => {
  // The allowlist test only means something if it would catch the case it was
  // written for. prodigi-config.ts is the module that *was* on the allowlist
  // and whose `env = process.env` defaults made every reader callable with no
  // argument. Pin the shape directly so a re-added default fails here rather
  // than depending on someone re-adding it to the allowlist above.
  const file = path.join(srcDir, "infrastructure", "prodigi", "prodigi-config.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const defaults: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node)) &&
      node.parameters.some((param) => param.initializer !== undefined)
    ) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "<anonymous>";
      defaults.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(
    defaults,
    [],
    `prodigi-config.ts readers must require their env argument, but these default one: ${defaults.join(", ")}`,
  );
});

test("only the allowlist can give a parameter default that reads something", () => {
  const offences = defaultParameterOffences();
  assert.deepEqual(
    offences,
    [],
    `a default parameter reads outside the allowlist:\n` +
      offences.map((o) => `  ${o.file}:${o.line} ${o.what}`).join("\n"),
  );
});

test("the allowlist is not wider than it needs to be", () => {
  // A guard that quietly accumulates exceptions stops guarding. Every entry
  // has to justify itself: the three above are the composition root, the
  // primitive reader, and the async Worker-env read — nothing else.
  assert.deepEqual([...ALLOWED].sort(), ["config.ts", "env.ts", "worker-bindings.ts"]);
});
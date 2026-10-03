/**
 * #118: the types now encode the domain, so the parsed domain values must not
 * be forced back with a cast or a non-null assertion.
 *
 * The four offenders were `record.format as PhysicalFormat`,
 * `record.size as PrintSize`, `record.frame as FrameFinish` and
 * `record.recipient!` in fulfillment.ts, plus the checkout route's
 * `as ShipToCountryCode | null` / `parsed.size!`. Each was a place the compiler
 * could not check the assumption, so a wrong shape at runtime blew past it.
 * Walked on the AST (not grepped) so a cast written inside a string or comment
 * is not mistaken for a real one, and so the check stays green only while the
 * files stay cast-free.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.join(import.meta.dirname, "..");

// The files that read parsed domain values (a checkout/quote body, a Prodigi
// result, or a stored order record) and narrow them. The webhook and other
// routes cast Stripe's own event objects, which are not this repo's domain
// values and are deliberately out of scope.
const DOMAIN_FILES = [
  "src/lib/fulfillment.ts",
  "src/app/api/quote/route.ts",
  "src/app/api/checkout/route.ts",
];

test("no `as` cast remains on parsed domain values", () => {
  const offenders: string[] = [];
  for (const rel of DOMAIN_FILES) {
    const file = path.join(root, rel);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        offenders.push(`${rel}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    offenders,
    [],
    `parsed domain values must not be forced with a cast: ${offenders.join(", ")}`,
  );
});

test("no `!` non-null assertion remains on parsed domain values", () => {
  const offenders: string[] = [];
  for (const rel of DOMAIN_FILES) {
    const file = path.join(root, rel);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isNonNullExpression(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        offenders.push(`${rel}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    offenders,
    [],
    `parsed domain values must not be forced non-null with !: ${offenders.join(", ")}`,
  );
});

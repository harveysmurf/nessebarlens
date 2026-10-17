/**
 * Load `.tsx` modules under the test runner.
 *
 * Node's type-stripping removes TypeScript syntax but not JSX, so importing any
 * `.tsx` file dies before it executes:
 *
 *   TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx"
 *
 * and `stripTypeScriptTypes` refuses JSX in both `strip` and `transform` mode,
 * so there is no built-in that does this. esbuild can, in about thirty lines.
 *
 * Two deliberate restrictions:
 *
 * - **`.tsx` only.** `.ts` keeps Node's own in-place type stripping. That is not
 *   an accident to work around: `scripts/coverage.mjs` states that its line
 *   numbers are trustworthy *because* nothing sits between the `.ts` and the code
 *   V8 sees. Routing `.ts` through esbuild would put a transpiler back in that
 *   path and invalidate the coverage report's line-to-source mapping — which is
 *   the exact failure the `ts.transpileModule` loader used to cause.
 *
 * - **Tests only.** This hook is registered from `tests/register.mjs`, not from
 *   `scripts/register.mjs`, so the ops scripts that share the resolve hook never
 *   gain a transpiler they were not written for.
 *
 * What this does *not* fix: line numbers for a loaded `.tsx` are esbuild's, not
 * the file's. That is invisible to the coverage gate, because `isGatedFile`
 * covers `src/domain`, `src/application`, `src/infrastructure` and the
 * `src/app/api` route handlers — and no `.tsx` is among them, the component tree
 * being excluded on purpose. A `.tsx` row may appear in the printed report with
 * line numbers that do not point at the source; it is not gated, and not read.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { resolve } from "../scripts/resolve-hooks.mjs";

export { resolve };

/**
 * `jsx: "automatic"` rather than esbuild's default `transform`, so components
 * do not need `React` in scope — matching what `jsx: react-jsx` does in tsconfig
 * and what Next itself compiles against.
 */
const TRANSFORM = {
  loader: "tsx",
  format: "esm",
  jsx: "automatic",
  target: "node24",
};

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    const sourcefile = fileURLToPath(url);
    const { code } = await esbuild.transform(await readFile(sourcefile, "utf8"), {
      ...TRANSFORM,
      sourcefile,
    });
    return { format: "module", shortCircuit: true, source: code };
  }
  return nextLoad(url, context);
}
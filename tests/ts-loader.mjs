import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Extensions to try, in order, for an extensionless relative specifier. */
const RESOLVE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs"];

/**
 * Resolve extensionless relative imports (./foo -> ./foo.ts).
 *
 * This deliberately does NOT rewrite source text. A regex over the transpiled
 * output also matches `from "./x"` sequences that appear inside string
 * literals, which silently mutates test needles and any source-grep fixture.
 * Resolving at the module level cannot have that failure mode.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const parentUrl = context.parentURL ?? import.meta.url;
    const url = new URL(specifier, parentUrl);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = new URL(url.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true, format: "module" };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts") && !url.endsWith(".mts")) {
    return nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: url,
  });
  return { format: "module", source: outputText, shortCircuit: true };
}

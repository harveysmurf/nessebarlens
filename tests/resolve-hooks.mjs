import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Extensions to try, in order, for an extensionless relative specifier. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/**
 * Resolve extensionless relative imports (./foo -> ./foo.ts).
 *
 * This is the only job left in this file. Type stripping is node's own
 * (node >= 24, erasable syntax only), which keeps every source line in place —
 * so there is no transpiler output to remap, and the coverage report's line
 * numbers are the ones a reader sees in the .ts.
 *
 * Resolving here rather than rewriting source text is deliberate: a regex over
 * output also matches `from "./x"` sequences inside string literals, which
 * silently mutates test needles and any source-grep fixture. A resolve hook
 * cannot have that failure mode.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const parentUrl = context.parentURL ?? import.meta.url;
    const url = new URL(specifier, parentUrl);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = new URL(url.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

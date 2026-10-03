import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FILE_NAME } from "./js-file-name.mjs";

/** Extensions to try, in order, for an extensionless specifier. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/** The `@/` prefix tsconfig maps to src/, used by every app/ module. */
const SRC_ALIAS = new URL("../src/", import.meta.url);

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
  if (specifier.startsWith("@/")) {
    return withExtension(new URL(specifier.slice(2), SRC_ALIAS), context, nextResolve);
  }
  // next has no exports map, so `next/server` is a file without an extension.
  if (specifier.startsWith("next/") && !/\.[cm]?js$/.test(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }
  if (specifier.startsWith(".") && !FILE_NAME.test(specifier)) {
    return withExtension(
      new URL(specifier, context.parentURL ?? import.meta.url),
      context,
      nextResolve,
    );
  }
  return nextResolve(specifier, context);
}

/** Resolves url, or the first of url + each source extension that exists. */
async function withExtension(url, context, nextResolve) {
  if (FILE_NAME.test(url.href)) return nextResolve(url.href, context);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = new URL(url.href + ext);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(url.href, context);
}

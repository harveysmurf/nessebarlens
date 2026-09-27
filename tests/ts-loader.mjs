import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

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
  const rewritten = outputText.replace(
    /(from\s+["'])(\.[^"']+)(["'])/g,
    (_match, open, spec, close) => {
      if (/\.(?:ts|js|mjs|cjs|json)$/.test(spec)) return open + spec + close;
      return open + spec + ".ts" + close;
    },
  );
  return { format: "module", source: rewritten, shortCircuit: true };
}

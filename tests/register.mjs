/**
 * Test-runner entry point. The hook itself lives in scripts/ because it is a
 * runtime concern, not a test concern: scripts/*.mjs that import src/lib (.ts,
 * extensionless) need it too — see #177.
 */
import { register } from "node:module";
import "../scripts/register.mjs";

// A second hook, registered after the one above so it resolves first and
// delegates to it: `tests/tsx-hooks.mjs` re-exports scripts' resolve unchanged
// and adds a `load` step for `.tsx`. Registering it here rather than in
// scripts/register.mjs keeps the transpiler out of the ops scripts — see the
// hook's own header for why `.ts` is deliberately left to Node.
register(new URL("./tsx-hooks.mjs", import.meta.url).href);

// tests/sqlite-d1.mts imports `node:sqlite` (#203). The feature is stable on
// the pinned Node 24 line, but some 24.x minors print an ExperimentalWarning
// for it; the engines range allows those, so suppress that one warning and
// leave every other warning intact.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const message =
    typeof warning === "string" ? warning : (warning && warning.message) || "";
  if (message.includes("SQLite")) return;
  return emitWarning.call(process, warning, ...rest);
};

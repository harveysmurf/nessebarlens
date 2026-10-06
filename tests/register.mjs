/**
 * Test-runner entry point. The hook itself lives in scripts/ because it is a
 * runtime concern, not a test concern: scripts/*.mjs that import src/lib (.ts,
 * extensionless) need it too — see #177.
 */
import "../scripts/register.mjs";

// tests/sqlite-d1.mts imports `node:sqlite` (#203). The feature is stable on
// the pinned Node 24.21.0, but some 24.x minors print an ExperimentalWarning
// for it; the engines range allows those, so suppress that one warning and
// leave every other warning intact.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const message =
    typeof warning === "string" ? warning : (warning && warning.message) || "";
  if (message.includes("SQLite")) return;
  return emitWarning.call(process, warning, ...rest);
};

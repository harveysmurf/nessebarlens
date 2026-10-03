/**
 * Test-runner entry point. The hook itself lives in scripts/ because it is a
 * runtime concern, not a test concern: scripts/*.mjs that import src/lib (.ts,
 * extensionless) need it too — see #177.
 */
import "../scripts/register.mjs";

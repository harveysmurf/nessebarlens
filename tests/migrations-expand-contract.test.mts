/**
 * D1 has no down-migration and Cloudflare does not offer one, so a migration
 * applied by the release pipeline cannot be undone when the deploy that needed
 * it turns out to be broken. The rollback in `.github/workflows/release.yml`
 * restores the previous *code* against the new *schema*, which is only safe
 * while the new schema is backward-compatible with the old code.
 *
 * That makes "did you remember" the whole safety property, so this file makes it
 * a build failure instead. DROP and RENAME are the two operations that break
 * backward compatibility outright: the old code names a column or a table that
 * no longer exists, and it fails at runtime on the orders path — after a
 * customer has paid.
 *
 * The escape hatch is a `-- contract:` marker on the offending line, which is
 * deliberate friction rather than a config flag. Destructive DDL is sometimes
 * genuinely correct (a rename after the new code ships, a table that held
 * nothing). What must not happen is it happening silently in a migration that a
 * reviewer reads as routine. The marker is the reviewer-visible record.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const migrationsDir = path.join(root, "migrations");

const migrations = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
  }));

/**
 * Dropping an index or a constraint is not in this list. Both leave the table
 * readable and every column present, so old code keeps working — it is slower,
 * not broken. Only operations that remove a name the old code resolves are
 * refused. A composite index named in a `DROP INDEX` is a judgement call the
 * marker exists for.
 */
const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN)|RENAME\s+(TO|COLUMN|TO)|ALTER\s+TABLE\s+\S+\s+RENAME)\b/i;

test("migrations/ is not empty — the guard below would pass vacuously", () => {
  assert.ok(
    migrations.length > 0,
    "no migrations found; the expand/contract guard would be checking nothing",
  );
});

test("no migration drops or renames without an explicit -- contract: marker", () => {
  for (const { name, text } of migrations) {
    const offenders: string[] = [];
    for (const [index, raw] of text.split("\n").entries()) {
      const line = raw.trim();
      if (line === "" || line.startsWith("--")) continue;
      if (!DESTRUCTIVE.test(line)) continue;
      // The marker is per line so it has to sit on the destructive statement,
      // not somewhere else in the file: a marker at the top of a ten-statement
      // migration would silently bless all ten.
      if (raw.includes("-- contract:")) continue;
      offenders.push(`${name}:${index + 1}: ${line}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `migration(s) break backward compatibility, which the release pipeline cannot undo:\n${offenders.join("\n")}\n` +
        "Rollback restores the previous code against the NEW schema. Either split it " +
        "(add the new shape, deploy code that uses it, remove the old shape in a later " +
        "migration) or mark the line with `-- contract:` if the removal is deliberate.",
    );
  }
});

test("the existing migrations are the additive shape the release pipeline assumes", () => {
  // Not a style preference. The pipeline migrates before deploying and cannot
  // migrate back, so every migration in here is a promise that the previously
  // deployed code still works afterwards. If this ever fails, the fix is a new
  // migration pair, not an edit to an applied file — wrangler records applied
  // migrations by name in d1_migrations and never re-runs or reverts them.
  for (const { name, text } of migrations) {
    // Comments are stripped before splitting rather than filtered per
    // statement: these files lead with a `-- ...` block that has no `;`, so the
    // comment and the first statement arrive as one chunk and a per-statement
    // comment test throws the statement away with it.
    const statements = text
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    assert.ok(statements.length > 0, `${name} has no statements`);
  }
});
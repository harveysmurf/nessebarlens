/**
 * A real database for the orders tests, not a statement-matcher (#203).
 *
 * `tests/fake-d1.mts` routed each query by substring and answered from
 * hand-written Maps, so a misspelled column, a wrong `WHERE`, or a migration
 * that no longer matches the code could not fail a test. This shim runs the
 * real schema and the real SQL on `node:sqlite` (`DatabaseSync`, built into
 * Node 24 — the version `.nvmrc` pins, so no new dependency).
 *
 * It applies every `migrations/*.sql` in filename order, then implements the
 * slice of D1 the store uses: `prepare(...).bind(...).first/all/run` and a
 * transactional `batch`. SQLite resolves column and table names when a
 * statement is prepared, so the code's own SQL is checked against the migrated
 * schema on every run.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqlRow = Record<string, unknown>;

export type D1Result<T = SqlRow> = {
  results: T[];
  meta: { changes: number };
};

export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = SqlRow>() => Promise<T | null>;
  run: () => Promise<D1Result>;
  all: <T = SqlRow>() => Promise<D1Result<T>>;
};

export type SqliteD1 = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: { run: () => Promise<unknown> }[]) => Promise<unknown[]>;
  /** Test-only: read rows directly to assert on stored state. */
  query: <T = SqlRow>(sql: string, ...binds: unknown[]) => T[];
  /**
   * Test-only: compile a statement against the migrated schema without
   * executing it. SQLite resolves table and column names at prepare time, so
   * this throws on a misspelled column or a table a migration dropped.
   */
  compile: (sql: string) => void;
  /**
   * Make the spend UPDATE for `token` change no rows while the row itself
   * still reads as live. That is the inter-statement race d1OrdersStore's
   * fallback exists for, and it is not reachable by corrupting a column: a
   * column the code reads as spent is spent in both statements. This
   * intercepts the one prepared statement and returns no row; it does not
   * re-implement the spend.
   */
  refuseSpendFor: (token: string) => void;
  /**
   * Make the spend UPDATE return a `record` column holding `raw` instead of
   * the json_object it builds. This is the shape a real row gets if the JSON
   * column is not what the UPDATE wrote; the store's fallback for it cannot be
   * reached by corrupting the row up front because the UPDATE overwrites that
   * column.
   */
  returnRawRecordFor: (token: string, raw: string) => void;
};

const SPEND_UPDATE = /UPDATE\s+download_tokens\s+SET[\s\S]*\bRETURNING\b/i;

const migrationsDir = path.join(import.meta.dirname, "..", "migrations");

/** Every migration, in the order wrangler would apply them. */
export function loadMigrations(): { name: string; sql: string }[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
    }));
}

/** A fresh in-memory D1 with the full migrated schema, no rows. */
export function sqliteD1(): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  for (const { sql } of loadMigrations()) db.exec(sql);

  const refusedSpends = new Set<string>();
  const rawSpendRecords = new Map<string, string>();

  function makeStatement(sql: string, binds: unknown[]): D1Statement {
    const isSpend = SPEND_UPDATE.test(sql);

    const statement: D1Statement = {
      bind: (...values: unknown[]) => makeStatement(sql, values),
      async first<T>() {
        const token = binds.length > 0 ? String(binds[0]) : "";
        if (isSpend && refusedSpends.has(token)) return null;
        const row = db.prepare(sql).get(...(binds as never[])) as SqlRow | undefined;
        if (row === undefined) return null;
        if (isSpend && rawSpendRecords.has(token)) {
          row.record = rawSpendRecords.get(token);
        }
        return row as T;
      },
      async run() {
        const result = db.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(result.changes) } };
      },
      async all<T>() {
        const rows = db.prepare(sql).all(...(binds as never[])) as T[];
        return { results: rows, meta: { changes: 0 } };
      },
    };
    return statement;
  }

  return {
    prepare: (sql: string) => makeStatement(sql, []),
    async batch(statements) {
      // D1 runs a batch in one transaction; mirror that so a mid-batch failure
      // rolls the whole thing back rather than leaving a partial write.
      db.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    query<T>(sql: string, ...binds: unknown[]) {
      return db.prepare(sql).all(...(binds as never[])) as T[];
    },
    compile(sql: string) {
      db.prepare(sql);
    },
    refuseSpendFor(token) {
      refusedSpends.add(token);
    },
    returnRawRecordFor(token, raw) {
      rawSpendRecords.set(token, raw);
    },
  };
}

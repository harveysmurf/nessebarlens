/**
 * In-memory D1Database for orders tests (#116).
 *
 * Implements prepare/bind/first/all/run/batch against the schema in
 * migrations/0001_init.sql. Conditional writes surface `meta.changes` the same
 * way real D1 does, so d1OrdersStore's optimistic lock and spend paths stay
 * honest under test.
 */

export type FakeD1Row = Record<string, unknown>;

export type FakeD1Database = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => ReturnType<FakeD1Database["prepare"]>;
    first: <T>() => Promise<T | null>;
    run: () => Promise<{ meta: { changes: number }; results: FakeD1Row[] }>;
    all: <T>() => Promise<{ results: T[]; meta: { changes: number } }>;
  };
  batch: (
    statements: { run: () => Promise<unknown> }[],
  ) => Promise<unknown[]>;
  orders: Map<string, FakeD1Row>;
  tokens: Map<string, FakeD1Row>;
  /**
   * Make the spend UPDATE for `token` change no rows while the row itself
   * still reads as live. That is the inter-statement race d1OrdersStore's
   * fallback exists for, and it is not reachable by corrupting a column: a
   * column the fake reads as spent is spent in both statements.
   */
  refuseSpendFor: (token: string) => void;
  /**
   * Make the spend UPDATE for `token` RETURN a `record` column holding
   * `raw` instead of the json_object it would build. This is the shape a real
   * row gets if the JSON column is not what the UPDATE wrote, and the store's
   * fallback for it cannot be reached by corrupting the row up front because
   * the UPDATE overwrites that column.
   */
  returnRawRecordFor: (token: string, raw: string) => void;
};

export function fakeD1(options: {
  orders?: Map<string, FakeD1Row>;
  tokens?: Map<string, FakeD1Row>;
} = {}): FakeD1Database {
  const orders = options.orders ?? new Map<string, FakeD1Row>();
  const tokens = options.tokens ?? new Map<string, FakeD1Row>();
  const refusedSpends = new Set<string>();
  const rawSpendRecords = new Map<string, string>();

  function prepare(sql: string) {
    const binds: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        binds.push(...values);
        return stmt;
      },
      async first<T>() {
        const result = await runQuery(sql, binds, orders, tokens, refusedSpends, rawSpendRecords);
        return (result.rows[0] as T) ?? null;
      },
      async run() {
        const result = await runQuery(sql, binds, orders, tokens, refusedSpends);
        return { meta: { changes: result.changes }, results: result.rows };
      },
      async all<T>() {
        const result = await runQuery(sql, binds, orders, tokens, refusedSpends);
        return { results: result.rows as T[], meta: { changes: result.changes } };
      },
    };
    return stmt;
  }

  return {
    prepare,
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    orders,
    tokens,
    refuseSpendFor(token: string) {
      refusedSpends.add(token);
    },
    returnRawRecordFor(token: string, raw: string) {
      rawSpendRecords.set(token, raw);
    },
  };
}

async function runQuery(
  sql: string,
  binds: unknown[],
  orders: Map<string, FakeD1Row>,
  tokens: Map<string, FakeD1Row>,
  refusedSpends: Set<string>,
  rawSpendRecords: Map<string, string>,
): Promise<{ rows: FakeD1Row[]; changes: number }> {
  if (sql.includes("SELECT record FROM orders WHERE session_id")) {
    const row = orders.get(String(binds[0]));
    return { rows: row ? [row] : [], changes: 0 };
  }
  if (sql.startsWith("INSERT INTO orders")) {
    const sessionId = String(binds[0]);
    const row = {
      record: binds[1],
      status: binds[2],
      terminal: binds[3],
      reason: binds[4],
      attempts: 1,
      updated_at: binds[5],
      created_at: binds[6],
      session_id: sessionId,
    };
    orders.set(sessionId, row);
    return { rows: [], changes: 1 };
  }
  if (sql.startsWith("UPDATE orders SET")) {
    const sessionId = String(binds[6]);
    const fromAttempts = Number(binds[7]);
    const existing = orders.get(sessionId);
    if (!existing || Number(existing.attempts) !== fromAttempts) {
      return { rows: [], changes: 0 };
    }
    existing.record = binds[0];
    existing.status = binds[1];
    existing.terminal = binds[2];
    existing.reason = binds[3];
    existing.attempts = binds[4];
    existing.updated_at = binds[5];
    return { rows: [], changes: 1 };
  }
  if (sql.includes("SELECT record FROM orders")) {
    return {
      rows: [...orders.values()].map((r) => ({ record: r.record })),
      changes: 0,
    };
  }
  if (sql.includes("SELECT record FROM download_tokens WHERE token")) {
    const row = tokens.get(String(binds[0]));
    return { rows: row ? [{ record: row.record }] : [], changes: 0 };
  }
  if (sql.includes("SELECT index_record FROM download_tokens")) {
    for (const row of tokens.values()) {
      if (row.session_id === binds[0]) {
        return { rows: [{ index_record: row.index_record }], changes: 0 };
      }
    }
    return { rows: [], changes: 0 };
  }
  if (sql.startsWith("INSERT INTO download_tokens")) {
    const token = String(binds[0]);
    tokens.set(token, {
      token,
      session_id: binds[1],
      expires_at: binds[2],
      max_downloads: binds[3],
      downloads: binds[4],
      record: binds[5],
      index_record: binds[6],
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("UPDATE download_tokens SET") && sql.includes("RETURNING")) {
    const token = String(binds[0]);
    const nowSec = Number(binds[1]);
    const row = tokens.get(token);
    if (!row) return { rows: [], changes: 0 };
    if (refusedSpends.has(token)) return { rows: [], changes: 0 };
    if (Number(row.expires_at) <= nowSec || Number(row.downloads) <= 0) {
      return { rows: [], changes: 0 };
    }
    row.downloads = Number(row.downloads) - 1;
    const record = {
      v: 1,
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      remaining: row.downloads,
    };
    row.record = rawSpendRecords.get(token) ?? JSON.stringify(record);
    row.index_record = JSON.stringify({ ...record, token });
    return {
      rows: [
        {
          session_id: row.session_id,
          expires_at: row.expires_at,
          downloads: row.downloads,
          record: row.record,
        },
      ],
      changes: 1,
    };
  }
  if (sql.includes("SELECT record, downloads, expires_at")) {
    const row = tokens.get(String(binds[0]));
    return { rows: row ? [row] : [], changes: 0 };
  }
  return { rows: [], changes: 0 };
}

#!/usr/bin/env node
/**
 * One-shot KV → D1 migration for orders and download tokens (#116).
 *
 * Reads the ORDERS KV namespace through the wrangler CLI (not the app). That is
 * why `[[kv_namespaces]]` stays in wrangler.toml even though nothing in the
 * application reads it any more — an operator who deletes the binding to tidy
 * up before running this script loses the source data.
 *
 * Usage:
 *   npm run migrate:orders
 *   npm run migrate:orders -- --overwrite
 *
 * Default is idempotent (`INSERT … ON CONFLICT DO NOTHING`). `--overwrite`
 * replaces existing rows. Corrupt order records are reported on stderr with
 * the same facts describeCorruptOrder gives and are neither inserted nor
 * deleted — money taken with no deliverable must stay visible.
 *
 * Download tokens: KV `remaining` becomes the D1 `downloads` column (downloads
 * still available). `max_downloads` is set to DOWNLOAD_TOKEN_MAX_DOWNLOADS
 * from the repo, because KV-era token records did not store a max. A token
 * minted under a different policy therefore gets a recomputed count — that is
 * the one field migration cannot recover exactly.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sqlWithBinds } from "./sql-binds.mjs";
// The key grammars and the download cap are owned by the modules the live
// worker reads them from. A hand-inlined copy here would be a second place
// where a key is classified, and a migration that skips a token the site will
// still honour (or imports one the site will refuse) is a silent divergence:
// the script would report success and the row would not be usable.
import { isCheckoutSessionId } from "../src/lib/order-decision.ts";
import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  isDownloadToken,
} from "../src/lib/download-token.ts";

export const DATABASE_NAME = "nessebar-lens-orders";
export const KV_BINDING = "ORDERS";

export function parseArgs(argv) {
  let overwrite = false;
  for (const arg of argv) {
    if (arg === "--overwrite") overwrite = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { overwrite, help: false };
}

/**
 * Facts about a rejected record — mirrors describeCorruptOrder without
 * importing src/ (this script is zero-dep and runs under plain node).
 */
export function describeCorruptOrder(raw, expectedSessionId) {
  const keyMatches = raw.includes(expectedSessionId);
  let json = false;
  let version = null;
  try {
    const parsed = JSON.parse(raw);
    json = true;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.v === "number") version = parsed.v;
    }
  } catch {
    json = false;
  }
  return { bytes: raw.length, json, version, keyMatches };
}

/**
 * Lightweight OrderRecord acceptance for migration. Deliberately stricter than
 * a full parseOrderRecord import would be (no catalog lookup): we only need to
 * refuse obvious garbage so money-taken-with-no-deliverable stays on stderr.
 */
export function looksLikeOrderRecord(raw, sessionId) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object") return false;
  if (value.v !== 1) return false;
  if (value.sessionId !== sessionId) return false;
  if (typeof value.status !== "string") return false;
  if (typeof value.terminal !== "boolean") return false;
  if (typeof value.updatedAt !== "string") return false;
  return true;
}

export function orderInsertSql(overwrite) {
  if (overwrite) {
    return `INSERT INTO orders (
      session_id, record, status, terminal, reason, attempts, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      record = excluded.record,
      status = excluded.status,
      terminal = excluded.terminal,
      reason = excluded.reason,
      attempts = excluded.attempts,
      updated_at = excluded.updated_at,
      created_at = excluded.created_at`;
  }
  return `INSERT INTO orders (
    session_id, record, status, terminal, reason, attempts, updated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO NOTHING`;
}

export function tokenInsertSql(overwrite) {
  if (overwrite) {
    return `INSERT INTO download_tokens (
      token, session_id, expires_at, max_downloads, downloads, record, index_record
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      session_id = excluded.session_id,
      expires_at = excluded.expires_at,
      max_downloads = excluded.max_downloads,
      downloads = excluded.downloads,
      record = excluded.record,
      index_record = excluded.index_record`;
  }
  return `INSERT INTO download_tokens (
    token, session_id, expires_at, max_downloads, downloads, record, index_record
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(token) DO NOTHING`;
}

export function orderBinds(sessionId, raw) {
  const record = JSON.parse(raw);
  const attempts =
    typeof record.attempts === "number" && record.attempts >= 1
      ? record.attempts
      : 1;
  const createdAt =
    typeof record.createdAt === "string" && record.createdAt.length > 0
      ? record.createdAt
      : record.updatedAt;
  const stored = {
    ...record,
    attempts,
    createdAt,
  };
  return [
    sessionId,
    JSON.stringify(stored),
    stored.status,
    stored.terminal ? 1 : 0,
    stored.reason ?? null,
    attempts,
    stored.updatedAt,
    createdAt,
  ];
}

export function tokenBinds(token, recordRaw, indexRaw) {
  const record = JSON.parse(recordRaw);
  const remaining =
    typeof record.remaining === "number" ? Math.max(0, record.remaining) : 0;
  const maxDownloads = DOWNLOAD_TOKEN_MAX_DOWNLOADS;
  // downloads column = remaining (downloads still available). max is the repo
  // constant because KV-era records did not store one — a token minted under a
  // different policy gets a recomputed count.
  const index =
    indexRaw !== null && indexRaw !== undefined
      ? indexRaw
      : JSON.stringify({ ...record, token });
  return [
    token,
    record.sessionId,
    record.expiresAt,
    maxDownloads,
    remaining,
    JSON.stringify({
      v: 1,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt,
      remaining,
    }),
    typeof index === "string" ? index : JSON.stringify(index),
  ];
}


export function classifyKvKey(key) {
  if (key.startsWith("dl:")) return { kind: "token", token: key.slice(3) };
  if (key.startsWith("dls:")) return { kind: "index", sessionId: key.slice(4) };
  if (isCheckoutSessionId(key)) return { kind: "order", sessionId: key };
  return { kind: "other", key };
}

/**
 * Pure migration over an already-loaded KV map. Exported for tests.
 */
export function migrateKvMap(kv, options = {}) {
  const overwrite = options.overwrite === true;
  const tally = {
    inserted: 0,
    skippedExisting: 0,
    corrupt: 0,
    tokensMigrated: 0,
  };
  const statements = [];
  const corruptReports = [];

  const indexes = new Map();
  for (const [key, value] of Object.entries(kv)) {
    const kind = classifyKvKey(key);
    if (kind.kind === "index") indexes.set(kind.sessionId, value);
  }

  const orderSql = orderInsertSql(overwrite);
  const tokSql = tokenInsertSql(overwrite);

  for (const [key, value] of Object.entries(kv)) {
    const kind = classifyKvKey(key);
    if (kind.kind === "order") {
      if (!looksLikeOrderRecord(value, kind.sessionId)) {
        tally.corrupt += 1;
        corruptReports.push({
          sessionId: kind.sessionId,
          ...describeCorruptOrder(value, kind.sessionId),
        });
        continue;
      }
      const binds = orderBinds(kind.sessionId, value);
      statements.push({ sql: orderSql, binds, kind: "order", sessionId: kind.sessionId });
      // Tally is refined by the executor when it knows conflict outcomes; for
      // the pure path assume insert (tests assert statement shape + corrupt).
      tally.inserted += 1;
    } else if (kind.kind === "token") {
      if (!isDownloadToken(kind.token)) continue;
      let record;
      try {
        record = JSON.parse(value);
      } catch {
        continue;
      }
      if (!record || record.v !== 1) continue;
      const indexRaw = indexes.get(record.sessionId) ?? null;
      const binds = tokenBinds(kind.token, value, indexRaw);
      statements.push({ sql: tokSql, binds, kind: "token", token: kind.token });
      tally.tokensMigrated += 1;
    }
  }

  return { statements, tally, corruptReports };
}

export function runMigrate(argv, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const listKv = options.listKv ?? defaultListKv;
  const getKv = options.getKv ?? defaultGetKv;
  const executeD1 = options.executeD1 ?? defaultExecuteD1;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: String(e instanceof Error ? e.message : e),
    };
  }
  if (parsed.help) {
    return {
      exitCode: 0,
      stdout:
        "Usage: node scripts/migrate-orders-kv-to-d1.mjs [--overwrite]\n",
      stderr: "",
    };
  }

  const keys = listKv(spawn);
  // An empty source is refused, not reported as a successful zero. Every way
  // this can happen is a wrong-configuration signal rather than an empty
  // namespace: a binding that resolves to local storage, a namespace id that
  // was recreated, or a typo in the binding name. Migrating nothing and
  // exiting 0 would leave the operator believing the data had moved, and the
  // KV binding is then deleted on that belief.
  if (keys.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `no keys found in KV binding ${KV_BINDING}: refusing to report a successful zero-row migration. ` +
        "Confirm the binding exists in wrangler.toml and that the namespace still holds orders.",
    };
  }
  const kv = {};
  for (const key of keys) {
    kv[key] = getKv(spawn, key);
  }

  const { statements, tally, corruptReports } = migrateKvMap(kv, parsed);
  for (const report of corruptReports) {
    console.error(
      JSON.stringify({ event: "order.corrupt", path: "migrate", ...report }),
    );
  }

  let inserted = 0;
  let skipped = 0;
  let tokens = 0;
  for (const stmt of statements) {
    const result = executeD1(spawn, sqlWithBinds(stmt.sql, stmt.binds));
    if (!result.ok) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: result.error ?? "d1 execute failed",
      };
    }
    const changes = result.changes ?? 1;
    if (stmt.kind === "order") {
      if (changes > 0) inserted += 1;
      else skipped += 1;
    } else if (stmt.kind === "token") {
      if (changes > 0) tokens += 1;
    }
  }

  const finalTally = {
    inserted,
    skippedExisting: skipped,
    corrupt: tally.corrupt,
    tokensMigrated: tokens,
  };
  const summary = `migrate:orders tally ${JSON.stringify(finalTally)}\n`;
  return { exitCode: 0, stdout: summary, stderr: "", tally: finalTally, statements };
}

function defaultListKv(spawn) {
  const keys = [];
  let cursor;
  do {
    const args = [
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding",
      KV_BINDING,
      "--prefix",
      "",
      // --remote is load-bearing, not hygiene. Without it wrangler resolves the
      // binding against local storage, which is empty on any machine that has
      // not run `wrangler dev`: the run reports tally zero, exits 0, and moves
      // nothing, while KV still holds every order. Verified against this
      // account -- the same command with --remote lists the namespace.
      "--remote",
    ];
    if (cursor) {
      args.push("--cursor", cursor);
    }
    const result = spawn("npx", args, { encoding: "utf8" });
    if ((result.status ?? 1) !== 0) {
      throw new Error(result.stderr || "kv key list failed");
    }
    const parsed = JSON.parse(result.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
    for (const entry of list) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (typeof name === "string") keys.push(name);
    }
    cursor = Array.isArray(parsed) ? undefined : parsed.cursor;
  } while (cursor);
  return keys;
}

function defaultGetKv(spawn, key) {
  const result = spawn(
    "npx",
    // --remote for the same reason as the list above; a local get returns an
    // empty string, which looksLikeOrderRecord then reports as a corrupt
    // record, so the missing flag would also fill stderr with every order.
    ["wrangler", "kv", "key", "get", key, "--binding", KV_BINDING, "--remote"],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `kv get failed for ${key}`);
  }
  return result.stdout ?? "";
}

function defaultExecuteD1(spawn, command) {
  const result = spawn(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--json",
      "--command",
      command,
    ],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    return { ok: false, error: result.stderr || "d1 execute failed" };
  }
  let changes = 1;
  try {
    const parsed = JSON.parse(result.stdout || "null");
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (entry && typeof entry.meta?.changes === "number") {
      changes = entry.meta.changes;
    }
  } catch {
    changes = 1;
  }
  return { ok: true, changes };
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const out = runMigrate(process.argv.slice(2));
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr + "\n");
    process.exit(out.exitCode);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

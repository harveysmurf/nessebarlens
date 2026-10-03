#!/usr/bin/env node
/**
 * Operator view over D1 orders (#116).
 *
 * Chosen as a CLI rather than an admin route: this Worker serves customers, and
 * an authenticated admin page is new attack surface on a site whose entire
 * value is a small static gallery.
 *
 * Usage:
 *   node scripts/list-orders.mjs [--status paid-unfulfilled|refunded|all] [--limit N]
 *   npm run orders -- --status paid-unfulfilled
 *
 * Builds a parameterised SELECT (printed for the D1 dashboard / support
 * threads), then runs it via `npx wrangler d1 execute … --remote --json` with
 * binds applied only after a closed-set status check and an integer limit
 * clamp — argv never lands in the SQL string raw. Zero dependencies.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sqlWithBinds } from "./sql-binds.mjs";

export const DATABASE_NAME = "nessebar-lens-orders";
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

const STATUS_ALLOW = new Set([
  "paid-unfulfilled",
  "refunded",
  "disputed",
  "paid",
  "all",
]);

/**
 * Build the parameterised SELECT. Status values are validated against a closed
 * set before they become binds — never interpolated into the SQL string from
 * raw argv.
 */
export function buildListOrdersSql(options = {}) {
  const status = options.status ?? "all";
  const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);

  if (!STATUS_ALLOW.has(status)) {
    throw new Error(
      `unknown --status ${status}; expected paid-unfulfilled|refunded|disputed|paid|all`,
    );
  }

  const binds = [];
  let where = "";
  if (status !== "all") {
    where = "WHERE status = ?";
    binds.push(status);
  }

  const sql = [
    "SELECT session_id, status, reason, attempts, created_at, updated_at, record",
    "FROM orders",
    where,
    "ORDER BY created_at ASC",
    "LIMIT ?",
  ]
    .filter(Boolean)
    .join(" ");
  binds.push(limit);
  return { sql, binds, status, limit };
}

export function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function parseArgs(argv) {
  let status = "all";
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--status") {
      status = argv[++i] ?? "all";
    } else if (arg === "--limit") {
      limit = argv[++i] ?? DEFAULT_LIMIT;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { status, limit, help: false };
}


export function formatTable(rows, nowMs = Date.now()) {
  const lines = [
    [
      "session_id",
      "status",
      "reason",
      "attempts",
      "age",
      "format",
      "slug",
      "amount",
    ].join("\t"),
  ];
  for (const row of rows) {
    let format = "";
    let slug = "";
    let amount = "";
    try {
      const record = JSON.parse(row.record);
      format = record.format ?? "";
      slug = record.photoSlug ?? "";
      amount = record.amountTotal ?? "";
    } catch {
      format = "?";
    }
    const created = Date.parse(row.created_at);
    const ageHours = Number.isFinite(created)
      ? `${Math.round(((nowMs - created) / 3600000) * 10) / 10}h`
      : "?";
    lines.push(
      [
        row.session_id,
        row.status,
        row.reason ?? "",
        row.attempts,
        ageHours,
        format,
        slug,
        amount,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

export function extractRows(wranglerJson) {
  if (Array.isArray(wranglerJson)) {
    for (const entry of wranglerJson) {
      if (entry && Array.isArray(entry.results)) return entry.results;
    }
    return [];
  }
  if (wranglerJson && Array.isArray(wranglerJson.results)) {
    return wranglerJson.results;
  }
  return [];
}

export function runListOrders(argv, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
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
        "Usage: node scripts/list-orders.mjs [--status paid-unfulfilled|refunded|all] [--limit N]\n",
      stderr: "",
    };
  }

  let built;
  try {
    built = buildListOrdersSql(parsed);
  } catch (e) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: String(e instanceof Error ? e.message : e),
    };
  }

  const { sql, binds, status, limit } = built;
  const inline = sqlWithBinds(sql, binds);
  const header = [
    `# status=${status} limit=${limit}`,
    `# SQL (parameterised): ${sql}`,
    `# binds: ${JSON.stringify(binds)}`,
    `# SQL (runnable): ${inline}`,
  ].join("\n");

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
      inline,
    ],
    { encoding: "utf8" },
  );

  if ((result.status ?? 1) !== 0) {
    return {
      exitCode: result.status ?? 1,
      stdout: header + "\n",
      stderr: result.stderr || "wrangler d1 execute failed",
    };
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(result.stdout ?? "null");
  } catch {
    return {
      exitCode: 1,
      stdout: header + "\n",
      stderr: "list-orders: wrangler did not return JSON",
    };
  }
  const rows = extractRows(parsedJson);
  const table = formatTable(rows, options.nowMs);
  return {
    exitCode: 0,
    stdout: `${header}\n${table}\n# ${rows.length} row(s)\n`,
    stderr: "",
  };
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const out = runListOrders(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  process.exit(out.exitCode);
}

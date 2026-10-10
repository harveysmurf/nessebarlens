#!/usr/bin/env node
/**
 * Audit refunded/disputed physical orders against Prodigi's live state (#309).
 *
 * Read-only by default: it lists orders whose D1 status is refunded/disputed,
 * reads each one's current Prodigi stage and shipments, and prints one row per
 * order. --cancel attempts cancellation only for orders Prodigi still reports
 * as cancellable (not shipped), re-reads each afterward, and reports the outcome.
 *
 * Why this script exists: until #308 the cancel endpoint was wrong (/cancel
 * instead of /actions/cancel), so every Prodigi cancel since 2026-10-01 was a
 * silent 404. This audit discovers which refunded/disputed prints were never
 * actually cancelled — and may have shipped.
 *
 * Usage:
 *   node --import ./scripts/register.mjs scripts/audit-prodigi-cancellations.mjs [--cancel] [--limit N]
 *
 * Requires:
 *   PRODIGI_API_BASE=https://api.prodigi.com  (live only; sandbox is refused)
 *   PRODIGI_API_KEY=...
 *   wrangler authenticated for the production D1 database.
 *
 * Don't:
 *   - run --cancel without first posting the read-only output on #309
 *   - touch D1 records (status stays refunded/disputed)
 *   - use the sandbox key or base
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sqlWithBinds } from "./sql-binds.mjs";
import {
  buildListOrdersSql,
  DATABASE_NAME,
  DEFAULT_LIMIT,
  extractRows,
  REVOKED_STATUSES,
} from "./list-orders.mjs";
import {
  readProdigiConfig,
  PRODIGI_LIVE_API_BASE,
  prodigiUrl,
} from "../src/infrastructure/prodigi/prodigi-config.ts";
import {
  cancelProdigiOrder,
  isSafeProdigiOrderId,
} from "../src/infrastructure/prodigi/prodigi-cancel.ts";

export const AUDIT_STATUSES = REVOKED_STATUSES;

export const AUDIT_USAGE = [
  "Usage: node --import ./scripts/register.mjs scripts/audit-prodigi-cancellations.mjs [--cancel] [--limit N]",
  "  --cancel  Attempt cancellation of orders Prodigi still reports as cancellable.",
  "           Review the read-only output before running with --cancel.",
  "  --limit   Max rows to audit (default 100, max 500).",
  "Requires PRODIGI_API_BASE=https://api.prodigi.com and PRODIGI_API_KEY.",
].join("\n") + "\n";

export function parseArgs(argv) {
  let cancel = false;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cancel") {
      cancel = true;
    } else if (arg === "--limit") {
      limit = argv[++i] ?? DEFAULT_LIMIT;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, cancel: false, limit: DEFAULT_LIMIT };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { cancel, limit, help: false };
}

/**
 * Parse a D1 `record` JSON value and return the fields the audit needs, or
 * null if the order is not an auditable physical order with a Prodigi id.
 *
 * `kind` is stored on the record (derived from `format` at write time by
 * order-decision.ts:buildRecord): "digital", "physical", or "unknown". Only
 * physical orders with a prodigiOrderId are auditable; the prodigiOrderId is
 * validated with the same guard prodigi-cancel.ts uses before it reaches a URL.
 */
export function parseRefundRecord(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  if (record.kind !== "physical") return null;
  const orderId = record.prodigiOrderId;
  if (typeof orderId !== "string" || !orderId || !isSafeProdigiOrderId(orderId)) {
    return null;
  }
  return {
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    prodigiOrderId: orderId,
    localStage:
      typeof record.prodigiStage === "string" ? record.prodigiStage : null,
    photoSlug: typeof record.photoSlug === "string" ? record.photoSlug : "",
    format: typeof record.format === "string" ? record.format : "",
    size: typeof record.size === "string" ? record.size : "",
    amountTotal:
      typeof record.amountTotal === "number" ? record.amountTotal : 0,
  };
}

/**
 * Keep only rows that are auditable physical orders with a Prodigi id.
 */
export function filterAuditableRows(rows) {
  const kept = [];
  for (const row of rows) {
    const parsed = parseRefundRecord(row.record);
    if (parsed) {
      kept.push({
        ...parsed,
        status: row.status,
        createdAt: row.created_at,
      });
    }
  }
  return kept;
}

/**
 * Substrings that mean the order has shipped or is otherwise terminal — the
 * order has left our control and cannot be cancelled. Matched case-insensitively
 * so "Shipped", "Delivered", "Returned", "Cancelled", "CancelFailed" all match.
 *
 * "ReadyToShip" does NOT match any marker: the order is still cancellable.
 */
const NON_CANCELLABLE_MARKERS = ["shipped", "delivered", "return", "cancel"];

/**
 * True when the Prodigi order has shipped or is terminal, and therefore not
 * cancellable. Checks both the stage string and any shipped shipments.
 */
export function isShippedOrder(prodigiStage, shipments) {
  if (prodigiStage) {
    const lower = prodigiStage.toLowerCase();
    for (const marker of NON_CANCELLABLE_MARKERS) {
      if (lower.includes(marker)) return true;
    }
  }
  if (Array.isArray(shipments)) {
    for (const s of shipments) {
      if (s && typeof s === "object" && s.status === "Shipped") return true;
    }
  }
  return false;
}

/** Format an integer cents amount as euros. */
export function formatAmount(amountTotal) {
  if (typeof amountTotal !== "number") return String(amountTotal);
  const neg = amountTotal < 0;
  const abs = Math.abs(amountTotal);
  const euros = (abs / 100).toFixed(2);
  return `${neg ? "-" : ""}${euros}€`;
}

function formatShipments(shipments) {
  if (!shipments || shipments.length === 0) return "(none)";
  return shipments
    .map((s) => {
      let carrier = s.carrier;
      if (carrier && typeof carrier === "object" && carrier.name) {
        carrier = carrier.name;
      }
      return `${s.status || "?"}/${carrier || "-"}`;
    })
    .join("; ");
}

/**
 * The audit table header.
 */
export const AUDIT_HEADER = [
  "session_id",
  "prodigi_order_id",
  "local_stage",
  "prodigi_stage",
  "note",
  "shipments",
  "amount",
  "cancellable",
].join("\t");

/**
 * Extract the stage and shipments from a raw Prodigi GET /orders/{id} response.
 */
export function extractProdigiOrder(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const order = data?.order;
  if (!order || typeof order !== "object") return null;
  const stage =
    typeof order.status?.stage === "string" ? order.status.stage : null;
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  return { stage, shipments };
}

/**
 * Read a Prodigi order via GET. Returns { ok: true, stage, shipments } on
 * success, or { ok: false, message, status } on failure.
 *
 * Uses readProdigiConfig for the host/key pair — never hard-codes the host.
 */
export async function readProdigiOrder(base, key, orderId, fetchImpl) {
  const url = prodigiUrl(base, `v4.0/orders/${orderId}`);
  let res;
  try {
    res = await (fetchImpl ?? fetch)(url, {
      headers: { "X-API-Key": key },
    });
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "network-error",
      status: null,
    };
  }
  const raw = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      message: `Prodigi GET HTTP ${res.status}`,
      status: res.status,
    };
  }
  const parsed = extractProdigiOrder(raw);
  if (!parsed) {
    return {
      ok: false,
      message: "Prodigi GET: order missing from response",
      status: res.status,
    };
  }
  return { ok: true, stage: parsed.stage, shipments: parsed.shipments };
}

/**
 * Format one audit row. `entry` carries the D1 fields plus Prodigi read results.
 */
export function formatAuditRow(entry) {
  const prodigiStage = entry.readStage ?? "-";
  const shipments = formatShipments(entry.prodigiShipments);
  const cancellable = entry.isCancellable ? "yes" : "no";
  const readError = entry.readError ? `ERR:${entry.readError}` : "";
  return [
    entry.sessionId,
    entry.prodigiOrderId,
    entry.localStage ?? "-",
    prodigiStage,
    readError,
    shipments,
    formatAmount(entry.amountTotal),
    cancellable,
  ].join("\t");
}

/**
 * Format the full audit table (header + rows + count).
 */
export function formatAuditTable(entries) {
  const lines = [AUDIT_HEADER];
  for (const entry of entries) {
    lines.push(formatAuditRow(entry));
  }
  return `${lines.join("\n")}\n# ${entries.length} order(s)\n`;
}

/** The cancel summary table header. */
export const CANCEL_HEADER = [
  "session_id",
  "prodigi_order_id",
  "cancel_result",
  "cancel_detail",
  "re_read_stage",
  "re_read_shipments",
].join("\t");

function formatCancelOutcome(result) {
  if (result.ok) return "cancelled";
  return `failed:${result.reason}`;
}

/** Format the cancel summary table. */
export function formatCancelTable(cancelEntries) {
  const lines = [CANCEL_HEADER];
  for (const entry of cancelEntries) {
    const outcome = formatCancelOutcome(entry.cancelResult);
    const detail = entry.cancelResult.ok
      ? String(entry.cancelResult.status ?? "")
      : entry.cancelResult.message ?? "";
    const shipments = formatShipments(entry.reReadShipments);
    const reReadStage = entry.reReadStage ?? "(re-read failed)";
    lines.push([
      entry.sessionId,
      entry.prodigiOrderId,
      outcome,
      detail,
      reReadStage,
      shipments,
    ].join("\t"));
  }
  const cancelled = cancelEntries.filter((e) => e.cancelResult.ok).length;
  const failed = cancelEntries.filter((e) => !e.cancelResult.ok).length;
  return `\n${lines.join("\n")}\n# cancel: ${cancelled} ok, ${failed} failed\n`;
}

function buildD1Header(built) {
  const statuses = built.statuses ?? [built.status];
  return [
    `# status IN (${statuses.join(", ")}) limit=${built.limit}`,
    `# SQL (parameterised): ${built.sql}`,
    `# binds: ${JSON.stringify(built.binds)}`,
    `# SQL (runnable): ${sqlWithBinds(built.sql, built.binds)}`,
  ].join("\n");
}

/**
 * The main audit flow:
 *
 * 1. Verify Prodigi config is live (not sandbox, not unconfigured).
 * 2. Build a parameterised SELECT for refunded/disputed orders.
 * 3. Run it against production D1 via wrangler.
 * 4. Filter for physical orders with a prodigiOrderId.
 * 5. Read each order from Prodigi.
 * 6. Print the audit table.
 * 7. If --cancel, cancel cancellable orders and report outcomes.
 *
 * `options` injects dependencies for testing:
 *   - spawnSync: mock the wrangler call
 *   - fetch: mock the Prodigi API
 *   - cancelProdigiOrder: mock the cancel call
 *   - nowMs: fixed timestamp for age calculations
 */
export async function runAudit(argv, options = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return { exitCode: 2, stdout: "", stderr: String(e instanceof Error ? e.message : e) };
  }
  if (parsed.help) {
    return { exitCode: 0, stdout: AUDIT_USAGE, stderr: "" };
  }

  const spawn = options.spawnSync ?? spawnSync;
  const fetchImpl = options.fetch ?? fetch;
  const cancelImpl = options.cancelProdigiOrder ?? cancelProdigiOrder;

  const config = readProdigiConfig(process.env);
  if (!config.ok || config.base !== PRODIGI_LIVE_API_BASE) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `PRODIGI_API_BASE must be ${PRODIGI_LIVE_API_BASE} (live); refusing to audit a sandbox or unconfigured deployment`,
    };
  }

  let built;
  try {
    built = buildListOrdersSql({
      statuses: AUDIT_STATUSES,
      limit: parsed.limit,
    });
  } catch (e) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: String(e instanceof Error ? e.message : e),
    };
  }

  const inline = sqlWithBinds(built.sql, built.binds);
  const header = buildD1Header(built);

  const result = spawn("npx", [
    "wrangler",
    "d1",
    "execute",
    DATABASE_NAME,
    "--remote",
    "--json",
    "--command",
    inline,
  ], { encoding: "utf8" });

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
      stderr: "audit-prodigi: wrangler did not return JSON",
    };
  }
  const rows = extractRows(parsedJson);
  const auditable = filterAuditableRows(rows);

  const entries = [];
  for (const order of auditable) {
    const read = await readProdigiOrder(
      config.base,
      config.key,
      order.prodigiOrderId,
      fetchImpl,
    );
    if (!read.ok) {
      entries.push({
        ...order,
        readStage: null,
        prodigiShipments: [],
        isCancellable: false,
        readError: read.message,
      });
    } else {
      const isCancellable = !isShippedOrder(read.stage, read.shipments);
      entries.push({
        ...order,
        readStage: read.stage,
        prodigiShipments: read.shipments,
        isCancellable,
      });
    }
  }

  const table = `${header}\n${formatAuditTable(entries)}`;

  let cancelOutput = "";
  if (parsed.cancel) {
    const cancelEntries = [];
    for (const entry of entries) {
      if (!entry.isCancellable || entry.readError) continue;

      const cancelResult = await cancelImpl({
        prodigiOrderId: entry.prodigiOrderId,
        sessionId: entry.sessionId,
      });

      const reRead = await readProdigiOrder(
        config.base,
        config.key,
        entry.prodigiOrderId,
        fetchImpl,
      );

      cancelEntries.push({
        sessionId: entry.sessionId,
        prodigiOrderId: entry.prodigiOrderId,
        cancelResult,
        reReadStage: reRead.ok ? reRead.stage : null,
        reReadShipments: reRead.ok ? reRead.shipments : [],
        reReadError: reRead.ok ? null : reRead.message,
      });
    }
    cancelOutput = formatCancelTable(cancelEntries);
  }

  return {
    exitCode: 0,
    stdout: table + cancelOutput,
    stderr: "",
  };
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  runAudit(process.argv.slice(2)).then(
    (out) => {
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr + "\n");
      process.exit(out.exitCode);
    },
    (e) => {
      console.error(`audit-prodigi: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}

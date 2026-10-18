#!/usr/bin/env node
/**
 * Static analytics report (#446).
 *
 * One command, one self-contained HTML file: no server, no dashboard, no
 * client-side JavaScript. Traffic comes from Cloudflare Web Analytics (the
 * same pageviews the beacon records); behaviour comes from Analytics Engine
 * (the same blobs `/api/contact` and `/api/e` write). The two totals will not
 * match — WA drops blocked clients and consent-limited browsers, AE writes are
 * best-effort — so the report names both sources instead of inventing a
 * combined number.
 *
 *   node scripts/analytics-report.mjs --period day|week|month [--end YYYY-MM-DD] [--out FILE]
 *
 * Period boundaries are Europe/Sofia calendar days, DST-aware. The default is
 * the last *complete* period ending before today: a half-finished day at 09:00
 * reads like a traffic collapse. `--end` anchors the period containing that
 * date, so `--end 2026-10-01 --period month` reports October 2026.
 *
 * Reads two tokens, never prints or embeds either:
 *   CF_ANALYTICS_READ_TOKEN — Analytics Engine read via the unified SQL API
 *   CF_WA_API_TOKEN         — zone/account analytics read for the WA GraphQL query
 * CF_ACCOUNT_ID is optional; the project account is the default.
 *
 * Exit 0 when both sources answered, 1 when either failed (the report is still
 * written, with the failure named in its section), 2 for CLI misuse.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const SOFIA_TZ = "Europe/Sofia";
export const SITE_HOST = "nessebarlens.com";
export const DEFAULT_ACCOUNT = "117232faceb06cc3cb98cedd86d59241";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";

/**
 * The interaction allowlist, mirroring `src/analytics/events.ts`. Duplicated
 * rather than imported because this script runs with plain `node` (no loader),
 * and a test asserts the two lists stay identical.
 */
export const INTERACTION_EVENTS = [
  "contact_open",
  "configurator_open",
  "configurator_submit",
];

const WA_QUERY = `query ($account: String!, $start: Time, $end: Time) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 500
        filter: {
          datetime_geq: $start
          datetime_lt: $end
          requestHost: "${SITE_HOST}"
        }
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions { requestPath }
      }
    }
  }
}`;

const AE_QUERY = `SELECT blob1 AS event, blob2 AS status, count() AS n
FROM events.analyticsEngine.nessebar_events
WHERE blob3 = 'production'
GROUP BY event, status
ORDER BY n DESC`;

const USAGE = `Usage: node scripts/analytics-report.mjs --period day|week|month [--end YYYY-MM-DD] [--out FILE]

  --period   day, week (ISO, Monday-Sunday), or month
  --end      the date whose period to report (default: last complete period)
  --out      output path (default: reports/analytics-<period>-<start>_<end>.html)`;

/** A CLI misuse: reported with the usage line, exit 2. */
export class UsageError extends Error {}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function formatDate({ y, m, d }) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date, days) {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

function weekday(date) {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

function isoWeekday(date) {
  return weekday(date) === 0 ? 7 : weekday(date);
}

/** Parse a `YYYY-MM-DD` calendar date, rejecting rollover dates. */
export function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new UsageError(`--end must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  const date = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > daysInMonth(date.y, date.m)) {
    throw new UsageError(`--end is not a calendar date: ${value}`);
  }
  return date;
}

function partsInZone(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

function zoneOffsetMs(instant, timeZone) {
  const p = partsInZone(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/** Midnight in `timeZone` for a calendar date, as a UTC instant. */
export function zonedMidnightUtc(date, timeZone = SOFIA_TZ) {
  const naive = Date.UTC(date.y, date.m - 1, date.d);
  let utc = naive - zoneOffsetMs(new Date(naive), timeZone);
  utc = naive - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

export function todayInSofia(now = new Date()) {
  const p = partsInZone(now, SOFIA_TZ);
  return { y: p.year, m: p.month, d: p.day };
}

/** The last complete period's final date, given today's Sofia date. */
export function defaultEnd(period, today) {
  if (period === "day") return addDays(today, -1);
  if (period === "week") return addDays(today, -isoWeekday(today));
  if (today.m === 1) return { y: today.y - 1, m: 12, d: 31 };
  return { y: today.y, m: today.m - 1, d: daysInMonth(today.y, today.m - 1) };
}

/** Expand an anchor date to the full period containing it. */
export function periodRange(period, anchor) {
  if (period === "day") return { startDate: anchor, endDate: anchor };
  if (period === "week") {
    const startDate = addDays(anchor, -(isoWeekday(anchor) - 1));
    return { startDate, endDate: addDays(startDate, 6) };
  }
  return {
    startDate: { y: anchor.y, m: anchor.m, d: 1 },
    endDate: { y: anchor.y, m: anchor.m, d: daysInMonth(anchor.y, anchor.m) },
  };
}

export function parseArgs(argv) {
  const args = { period: null, end: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} needs a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--period" || arg.startsWith("--period=")) {
      args.period = arg === "--period" ? takeValue("--period") : arg.slice("--period=".length);
    } else if (arg === "--end" || arg.startsWith("--end=")) {
      args.end = arg === "--end" ? takeValue("--end") : arg.slice("--end=".length);
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      args.out = arg === "--out" ? takeValue("--out") : arg.slice("--out=".length);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (!args.period) throw new UsageError("--period is required");
  if (!["day", "week", "month"].includes(args.period)) {
    throw new UsageError(`--period must be day, week, or month, got ${JSON.stringify(args.period)}`);
  }
  if (args.end !== null) parseDate(args.end);
  return args;
}

export function defaultOutPath(period, startDate, endDate) {
  return path.join(
    "reports",
    `analytics-${period}-${formatDate(startDate)}_${formatDate(endDate)}.html`,
  );
}

async function postJson(fetchImpl, url, token, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(String(payload.errors[0]?.message ?? "API error"));
  }
  return payload;
}

export function summarizeWa(groups) {
  const paths = [];
  let pageviews = 0;
  let visits = 0;
  for (const group of groups) {
    const count = Number(group.count ?? 0);
    pageviews += count;
    visits += Number(group.sum?.visits ?? 0);
    paths.push({ path: String(group.dimensions?.requestPath ?? ""), count });
  }
  paths.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { pageviews, visits, topPaths: paths.slice(0, 10) };
}

export function summarizeAe(rows) {
  const interactions = [];
  const contacts = [];
  for (const row of rows) {
    const count = Number(row.n ?? 0);
    if (row.event === "contact") {
      contacts.push({ status: String(row.status ?? ""), count });
    } else {
      interactions.push({ event: String(row.event ?? ""), path: String(row.status ?? ""), count });
    }
  }
  interactions.sort((a, b) => b.count - a.count || a.event.localeCompare(b.event) || a.path.localeCompare(b.path));
  contacts.sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  return { interactions, contacts };
}

async function fetchWa({ token, account, start, end, fetchImpl }) {
  if (!token) throw new Error("CF_WA_API_TOKEN is not set");
  const payload = await postJson(fetchImpl, GRAPHQL_URL, token, {
    query: WA_QUERY,
    variables: { account, start, end },
  });
  const groups = payload?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
  return summarizeWa(Array.isArray(groups) ? groups : []);
}

async function fetchAe({ token, account, start, end, fetchImpl }) {
  if (!token) throw new Error("CF_ANALYTICS_READ_TOKEN is not set");
  const payload = await postJson(fetchImpl, SQL_URL, token, {
    query: AE_QUERY,
    scope: { accountTag: account },
    time_range: { start, end },
  });
  const rows = payload?.data;
  return summarizeAe(Array.isArray(rows) ? rows : []);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function table(headers, rows) {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sourceFailure(name, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `<p class="error">${escapeHtml(name)} unavailable — ${escapeHtml(message)}</p>`;
}

export function renderHtml({ period, startDate, endDate, startUtc, endUtc, now, wa, ae }) {
  const range = `${formatDate(startDate)} → ${formatDate(endDate)}`;
  const utcRange = `${startUtc.toISOString()} → ${endUtc.toISOString()}`;
  const generated = new Intl.DateTimeFormat("en-GB", {
    timeZone: SOFIA_TZ,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(now);

  const traffic = wa.ok
    ? `${wa.data.topPaths.length === 0 ? '<p class="empty">No data for this period.</p>' : table(
        ["Path", "Pageviews"],
        wa.data.topPaths.map((row) => [row.path, number(row.count)]),
      )}`
    : sourceFailure("Web Analytics", wa.error);

  const totals = wa.ok
    ? `<dl class="stats">
      <div><dt>Pageviews</dt><dd>${number(wa.data.pageviews)}</dd></div>
      <div><dt>Visits</dt><dd>${number(wa.data.visits)}</dd></div>
    </dl>`
    : "";

  const behaviour = ae.ok
    ? `
      <h3>Interaction events</h3>
      ${ae.data.interactions.length === 0
        ? '<p class="empty">No data for this period.</p>'
        : table(
            ["Event", "Path", "Count"],
            ae.data.interactions.map((row) => [row.event, row.path || "—", number(row.count)]),
          )}
      <h3>Contact outcomes</h3>
      ${ae.data.contacts.length === 0
        ? '<p class="empty">No data for this period.</p>'
        : table(
            ["Status", "Count"],
            ae.data.contacts.map((row) => [row.status, number(row.count)]),
          )}`
    : sourceFailure("Analytics Engine", ae.error);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Nessebar Lens — ${period} analytics ${range}`)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0 auto; max-width: 52rem; padding: 2.5rem 1.5rem 4rem; font: 15px/1.5 Georgia, "Times New Roman", serif; color: #1c1917; background: #fff; }
  h1 { font-size: 1.7rem; font-weight: normal; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; margin: 2.25rem 0 .75rem; border-bottom: 1px solid #d6d3d1; padding-bottom: .35rem; }
  h3 { font-size: .95rem; margin: 1.25rem 0 .5rem; }
  .meta { color: #57534e; font-size: .85rem; margin: .15rem 0; }
  .note { color: #78716c; font-size: .8rem; margin-top: 2.5rem; border-top: 1px solid #e7e5e4; padding-top: .75rem; }
  .stats { display: flex; gap: 2.5rem; margin: .5rem 0 1.25rem; }
  .stats div { margin: 0; }
  dt { color: #78716c; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
  dd { margin: .1rem 0 0; font-size: 1.6rem; }
  table { width: 100%; border-collapse: collapse; margin: .25rem 0 1rem; font-size: .88rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
  th { color: #57534e; font-weight: normal; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; }
  td:last-child, th:last-child { text-align: right; white-space: nowrap; }
  .empty { color: #78716c; font-style: italic; }
  .error { color: #9a3412; }
  @media print { body { padding: 0; max-width: none; } h2 { break-after: avoid; } table { break-inside: avoid; } }
</style>
</head>
<body>
<header>
  <h1>Nessebar Lens — analytics</h1>
  <p class="meta">${escapeHtml(`${period[0].toUpperCase()}${period.slice(1)} · ${range} (Europe/Sofia)`)}</p>
  <p class="meta">UTC range ${escapeHtml(utcRange)}</p>
  <p class="meta">Generated ${escapeHtml(generated)} (Europe/Sofia)</p>
</header>
<section>
  <h2>Traffic</h2>
  ${totals}
  ${wa.ok ? `<h3>Top paths</h3>${traffic}` : traffic}
</section>
<section>
  <h2>Behaviour</h2>
  ${behaviour}
</section>
<p class="note">Web Analytics is the cookieless traffic baseline; Analytics Engine is best-effort behaviour from the site's own events. The totals will not
match (blocked clients, consent, ad blockers). Staging is excluded: Web Analytics is filtered to ${escapeHtml(SITE_HOST)} and behaviour to
blob3 = production.</p>
</body>
</html>
`;
}

/**
 * Run one report. Everything external is injected so the tests never touch the
 * network or the real filesystem.
 */
export async function runReport({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  writeReport = async (outPath, html) => {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, html, "utf8");
  },
} = {}) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, help: true, html: "", outPath: null, failures: [] };

  const anchor = args.end === null ? defaultEnd(args.period, todayInSofia(now)) : parseDate(args.end);
  const { startDate, endDate } = periodRange(args.period, anchor);
  const startUtc = zonedMidnightUtc(startDate);
  const endUtc = zonedMidnightUtc(addDays(endDate, 1));
  const start = startUtc.toISOString();
  const end = endUtc.toISOString();
  const account = env.CF_ACCOUNT_ID || DEFAULT_ACCOUNT;

  const [wa, ae] = await Promise.all([
    fetchWa({ token: env.CF_WA_API_TOKEN, account, start, end, fetchImpl }).then(
      (data) => ({ ok: true, data }),
      (error) => ({ ok: false, error }),
    ),
    fetchAe({ token: env.CF_ANALYTICS_READ_TOKEN, account, start, end, fetchImpl }).then(
      (data) => ({ ok: true, data }),
      (error) => ({ ok: false, error }),
    ),
  ]);

  const outPath = args.out || defaultOutPath(args.period, startDate, endDate);
  const html = renderHtml({
    period: args.period,
    startDate,
    endDate,
    startUtc,
    endUtc,
    now,
    wa,
    ae,
  });
  await writeReport(outPath, html);

  const failures = [
    ...(wa.ok ? [] : ["Web Analytics"]),
    ...(ae.ok ? [] : ["Analytics Engine"]),
  ];
  return { code: failures.length === 0 ? 0 : 1, help: false, html, outPath, failures };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  writeReport,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await runReport({ argv, env, now, fetchImpl, writeReport });
    if (result.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    stdout.write(`${result.outPath}\n`);
    if (result.code !== 0) {
      stderr.write(`analytics-report: ${result.failures.join(" and ")} failed; report written anyway\n`);
    }
    return result.code;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`analytics-report: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    stderr.write(`analytics-report: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

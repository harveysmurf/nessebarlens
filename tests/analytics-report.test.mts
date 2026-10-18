/**
 * The static analytics report (#446).
 *
 * The network and the filesystem are injected, so every case here is a pure
 * function call: no live Cloudflare account, no token, no file writes. The
 * manual verification (a real day/week/month against the account) stays a
 * separate step — a fixture proves the report renders what the APIs return, not
 * that the account returns what we expect.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TRACK_EVENTS } from "../src/analytics/events.ts";
import {
  DEFAULT_ACCOUNT,
  INTERACTION_EVENTS,
  UsageError,
  addDays,
  defaultEnd,
  defaultOutPath,
  escapeHtml,
  main,
  parseArgs,
  parseDate,
  periodRange,
  renderHtml,
  runReport,
  summarizeAe,
  summarizeWa,
  todayInSofia,
  zonedMidnightUtc,
} from "../scripts/analytics-report.mjs";

const TOKENS: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  CF_ANALYTICS_READ_TOKEN: "ae-token",
  CF_WA_API_TOKEN: "wa-token",
};

const NOW = new Date("2026-10-18T09:00:00Z");

const WA_GROUPS = [
  { count: 5, sum: { visits: 4 }, dimensions: { requestPath: "/" } },
  { count: 2, sum: { visits: 0 }, dimensions: { requestPath: "/fine-art" } },
];

const AE_ROWS = [
  { event: "configurator_open", status: "/prints/a", n: 4 },
  { event: "contact", status: "ok", n: 1 },
];

type Call = { url: string; token: string; body: Record<string, unknown> };

function fakeFetch({
  wa = { status: 200, payload: { data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: WA_GROUPS }] } } } },
  ae = { status: 200, payload: { data: AE_ROWS } },
  calls,
}: {
  wa?: { status: number; payload: unknown };
  ae?: { status: number; payload: unknown };
  calls?: Call[];
} = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    calls?.push({ url, token, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const answer = url.includes("graphql") ? wa : ae;
    return new Response(JSON.stringify(answer.payload), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Capture the report instead of writing it. */
function writer() {
  const writes: { path: string; html: string }[] = [];
  return {
    writes,
    writeReport: async (outPath: string, html: string) => {
      writes.push({ path: outPath, html });
    },
  };
}

function run(overrides: Record<string, unknown> = {}) {
  const sink = writer();
  return {
    sink,
    result: runReport({
      argv: ["--period", "day", "--end", "2026-10-17"],
      env: TOKENS,
      now: NOW,
      fetchImpl: fakeFetch(),
      writeReport: sink.writeReport,
      ...overrides,
    }),
  };
}

test("the interaction allowlist mirrors src/analytics/events.ts", () => {
  assert.deepEqual(INTERACTION_EVENTS, [...TRACK_EVENTS]);
});

test("a Sofia date comes from the instant, not the host timezone", () => {
  assert.deepEqual(todayInSofia(NOW), { y: 2026, m: 10, d: 18 });
  // 22:30Z is already the next day in Sofia (UTC+3 in October).
  assert.deepEqual(todayInSofia(new Date("2026-10-18T22:30:00Z")), { y: 2026, m: 10, d: 19 });
});

test("the default end is the last complete period", () => {
  const sunday = { y: 2026, m: 10, d: 18 };
  assert.deepEqual(defaultEnd("day", sunday), { y: 2026, m: 10, d: 17 });
  // A week is complete only once its Sunday has passed.
  assert.deepEqual(defaultEnd("week", sunday), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(defaultEnd("week", { y: 2026, m: 10, d: 19 }), { y: 2026, m: 10, d: 18 });
  assert.deepEqual(defaultEnd("month", sunday), { y: 2026, m: 9, d: 30 });
  assert.deepEqual(defaultEnd("month", { y: 2026, m: 1, d: 15 }), { y: 2025, m: 12, d: 31 });
  assert.deepEqual(defaultEnd("month", { y: 2026, m: 3, d: 1 }), { y: 2026, m: 2, d: 28 });
});

test("week ranges are ISO weeks, including across a year boundary", () => {
  const { startDate, endDate } = periodRange("week", { y: 2026, m: 1, d: 1 });
  assert.deepEqual(startDate, { y: 2025, m: 12, d: 29 });
  assert.deepEqual(endDate, { y: 2026, m: 1, d: 4 });
  const month = periodRange("month", { y: 2026, m: 2, d: 17 });
  assert.equal(month.startDate.d, 1);
  assert.equal(month.endDate.d, 28);
});

test("Sofia midnights follow the DST transitions", () => {
  const iso = (date: { y: number; m: number; d: number }) => zonedMidnightUtc(date).toISOString();
  assert.equal(iso({ y: 2026, m: 3, d: 29 }), "2026-03-28T22:00:00.000Z");
  assert.equal(iso({ y: 2026, m: 3, d: 30 }), "2026-03-29T21:00:00.000Z");
  assert.equal(iso({ y: 2026, m: 10, d: 25 }), "2026-10-24T21:00:00.000Z");
  assert.equal(iso({ y: 2026, m: 10, d: 26 }), "2026-10-25T22:00:00.000Z");
});

test("a DST change makes the reported day 23 or 25 hours long", () => {
  const { startDate, endDate } = periodRange("day", { y: 2026, m: 3, d: 29 });
  const hours =
    (zonedMidnightUtc(addDays(endDate, 1)).getTime() - zonedMidnightUtc(startDate).getTime()) / 3_600_000;
  assert.equal(hours, 23);
  const fall = periodRange("day", { y: 2026, m: 10, d: 25 });
  const fallHours =
    (zonedMidnightUtc(addDays(fall.endDate, 1)).getTime() - zonedMidnightUtc(fall.startDate).getTime()) /
    3_600_000;
  assert.equal(fallHours, 25);
});

test("parseDate rejects impossible dates instead of rolling them over", () => {
  assert.deepEqual(parseDate("2026-02-28"), { y: 2026, m: 2, d: 28 });
  assert.throws(() => parseDate("2026-02-30"), UsageError);
  assert.throws(() => parseDate("2026-13-01"), UsageError);
  assert.throws(() => parseDate("2026-1-1"), UsageError);
  assert.throws(() => parseDate("yesterday"), UsageError);
});

test("arguments: period, optional end/out, and help", () => {
  assert.deepEqual(parseArgs(["--period", "day"]), { period: "day", end: null, out: null, help: false });
  assert.equal(parseArgs(["--period=week", "--end=2026-01-01", "--out=x.html"]).end, "2026-01-01");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(["--period", "quarter"]), UsageError);
  assert.throws(() => parseArgs(["--period"]), UsageError);
  assert.throws(() => parseArgs(["--period", "day", "--bogus"]), UsageError);
  assert.equal(defaultOutPath("month", { y: 2026, m: 9, d: 1 }, { y: 2026, m: 9, d: 30 }), "reports/analytics-month-2026-09-01_2026-09-30.html");
});

test("a happy report renders both sources, with no script or remote asset", async () => {
  const calls: Call[] = [];
  const { result, sink } = run({ fetchImpl: fakeFetch({ calls }) });
  const { code, html, outPath, failures } = await result;
  assert.equal(code, 0);
  assert.deepEqual(failures, []);
  assert.equal(outPath, "reports/analytics-day-2026-10-17_2026-10-17.html");
  assert.equal(sink.writes.length, 1);
  assert.match(html, /Pageviews/);
  assert.match(html, /7/);
  assert.match(html, /Visits/);
  assert.match(html, /\/fine-art/);
  assert.match(html, /configurator_open/);
  assert.match(html, /Contact outcomes/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.token, "Bearer wa-token");
  assert.equal(calls[1]?.token, "Bearer ae-token");
  const aeBody = calls[1]?.body as { scope: { accountTag: string }; time_range: { start: string; end: string } };
  assert.equal(aeBody.scope.accountTag, DEFAULT_ACCOUNT);
  assert.equal(aeBody.time_range.start, "2026-10-16T21:00:00.000Z");
  assert.equal(aeBody.time_range.end, "2026-10-17T21:00:00.000Z");
});

test("an empty period says so instead of rendering bare tables", async () => {
  const { result } = run({
    fetchImpl: fakeFetch({
      wa: { status: 200, payload: { data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [] }] } } } },
      ae: { status: 200, payload: { data: [] } },
    }),
  });
  const { code, html } = await result;
  assert.equal(code, 0);
  assert.equal(html.match(/No data for this period\./g)?.length, 3);
});

test("one failing source still writes the report and exits 1", async () => {
  const { result, sink } = run({ fetchImpl: fakeFetch({ wa: { status: 500, payload: {} } }) });
  const { code, html, failures } = await result;
  assert.equal(code, 1);
  assert.deepEqual(failures, ["Web Analytics"]);
  assert.equal(sink.writes.length, 1);
  assert.match(html, /Web Analytics unavailable — HTTP 500/);
  // The other source still renders.
  assert.match(html, /configurator_open/);
});

test("a missing token fails that source without calling the network", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { result } = run({
    env: { NODE_ENV: "test", CF_ANALYTICS_READ_TOKEN: "ae-token" },
    fetchImpl,
  });
  const { code, html, failures } = await result;
  assert.equal(code, 1);
  assert.deepEqual(failures, ["Web Analytics"]);
  assert.match(html, /CF_WA_API_TOKEN is not set/);
  // AE still called.
  assert.equal(called, true);
});

test("values from the API are escaped, never trusted as markup", async () => {
  const { result } = run({
    fetchImpl: fakeFetch({
      ae: {
        status: 200,
        payload: {
          data: [
            { event: "<img src=x onerror=alert(1)>", status: '"><script>', n: 1 },
            { event: "contact", status: "<b>ok</b>", n: 1 },
          ],
        },
      },
    }),
  });
  const { html } = await result;
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;ok&lt;\/b&gt;/);
  assert.equal(escapeHtml("<&>'\"") , "&lt;&amp;&gt;&#39;&quot;");
});

test("summaries sort by count and cap the path table at ten", () => {
  const groups = Array.from({ length: 12 }, (_, index) => ({
    count: index + 1,
    sum: { visits: 0 },
    dimensions: { requestPath: `/p${index}` },
  }));
  const wa = summarizeWa(groups);
  assert.equal(wa.pageviews, 78);
  assert.equal(wa.topPaths.length, 10);
  assert.equal(wa.topPaths[0]?.path, "/p11");

  const ae = summarizeAe([
    { event: "b", status: "/x", n: 1 },
    { event: "a", status: "/y", n: 3 },
    { event: "contact", status: "ok", n: 2 },
    { event: "contact", status: "invalid", n: 5 },
  ]);
  assert.deepEqual(ae.interactions.map((row) => row.event), ["a", "b"]);
  assert.deepEqual(ae.contacts.map((row) => row.status), ["invalid", "ok"]);
});

test("renderHtml labels a failed section and never embeds the supplied token", () => {
  const html = renderHtml({
    period: "week",
    startDate: { y: 2026, m: 10, d: 12 },
    endDate: { y: 2026, m: 10, d: 18 },
    startUtc: new Date("2026-10-11T21:00:00Z"),
    endUtc: new Date("2026-10-18T21:00:00Z"),
    now: NOW,
    wa: { ok: false, error: new Error("HTTP 401") },
    ae: { ok: true, data: summarizeAe([]) },
  });
  assert.match(html, /Week · 2026-10-12 → 2026-10-18/);
  assert.match(html, /Web Analytics unavailable — HTTP 401/);
  assert.doesNotMatch(html, /token/i);
});

test("CLI misuse exits 2 with usage, help exits 0", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: { write: (chunk: string) => out.push(chunk) } as unknown as typeof process.stdout,
    stderr: { write: (chunk: string) => err.push(chunk) } as unknown as typeof process.stderr,
  };
  const bad = await main({ argv: ["--period", "year"], ...io });
  assert.equal(bad, 2);
  assert.match(err.join(""), /--period must be day, week, or month/);
  const help = await main({ argv: ["--help"], ...io });
  assert.equal(help, 0);
  assert.match(out.join(""), /Usage:/);
});

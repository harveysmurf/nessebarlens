<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tailwind scans file text, not code

Tailwind v4 finds candidate class names by reading **file text** anywhere under
the project root. A utility named in an assertion, a comment, or an ordinary
sentence becomes a real rule in the shipped stylesheet. There is no "code only"
mode, and deleting a utility from `src/` does not delete its rule while something
else still mentions it.

So the paths that are not pages are excluded explicitly, with `@source not`
directly above the token block in `src/app/globals.css`: the test suite,
`scripts/`, `DEVELOPMENT.md`, and this file. That comment block is where the
long version lives; it is the thing to read before touching the theme.

**What that means for the next change here:**

- **Exclusion is explicit and named, never counted.** `border-palette.test.mts`
  lists each excluded path individually, because an unscanned path is the failure
  it exists for and "three are excluded" would not say which one went missing. A
  new doc or test directory goes in that list in the same commit it is created.
- **Do not name a utility in this file.** It is excluded, but the discipline is
  the point: describe a colour by its ramp and step ("the muted text step", "the
  retired border step"), not by the class name. A file that documents the hazard
  must not be an instance of it.
- **A test that asserts on compiled CSS narrows its own build** — `source(none)`
  plus an explicit `@source` — so the suite's own quoted class names cannot
  satisfy the assertion. `gallery-tiles.test.mts` established that pattern; its
  header explains why compiling beats reading source, since a plausible-looking
  string can emit nothing and still satisfy a source-text assertion.
- **A dead rule is worse than dead code**: it tells the production stylesheet a
  colour or a layout is available when the design says it is not. That is why the
  contrast and palette checks derive their values from `globals.css` instead of
  hard-coding literals — a literal keeps passing after the background moves.
- **Guards assert source text, not a default-detection build.** The scan cache is
  keyed on file content and returned stale candidates, so a measurement of a
  default build passed over a mutation that should have failed it. A guard that
  can pass when it should fail is worse than no guard; prefer a check you can
  demonstrate failing by mutation.
- **Name a constant, never restate its value in prose.** A sentence that writes
  `50-65` or `100-160` drifts the moment the constant moves, and a diff review
  cannot catch it: the changed line is the constant, while the stale sentence
  sits above it, unchanged and unremarked. It happened here — a test header
  claimed `120-160` for a floor already at 100, and the reviewer read the diff
  and missed it too. Name `TITLE_MIN`/`TITLE_MAX` and let the range be read from
  the code; then there is nothing to drift. No test for this, and there should
  not be one: a test that parses comments is the fragile-measurement mistake
  above, wearing a different hat.
- **A measurement reads the exported predicate, not the source it came from.**
  The SERP windows were checked once by a scratch script that regex-matched the
  literal rows of `PAGE_COPY` and skipped `/` without error, because that row is
  `"/": HOME_COPY` — a reference, not a literal. Its numbers were plausible and
  one route short, and a floor got set above the homepage's own description on
  the strength of them. Anything that measures a guard imports the module and
  asks it; a hand-rolled second measurer left on disk is how the wrong number
  comes back.

# Analytics: two sources, one number you act on

**Analytics Engine owns behaviour.** Web Analytics is the cookieless traffic and
Core Web Vitals baseline only; its totals will not match AE (ad blockers,
consent, worker-generated HTML). Read AE for "did they submit", WA for "how many
arrived". The site is an OpenNext Worker, and Cloudflare's automatic beacon
injection **does** fire into its HTML — but only for browser-like user agents, so
a `curl` of `/` cannot see it. "Zero matches for `cloudflareinsights`" measured
curl, not the site. The manual beacon in `src/components/AnalyticsBeacon.tsx` is
the only pageview source because the Web Analytics site is set to manual
installation and the zone's RUM setting is off, not because the Worker blocks
injection. Two beacons do not double-count: the first seeds `window.__cfBeacon`,
ours merges into it and loses `send.to`, and the result is zero pageviews. So
`scripts/smoke.sh` fetches `/` with a browser UA and fails the release if the
body carries more than one. The beacon posts cross-origin to
`cloudflareinsights.com` via `send.to` (the Worker 404s the relative
`/cdn-cgi/rum`), and it is suppressed on localhost/127.0.0.1 so dev runs do not
inflate WA.

## Dataset and event shape

Dataset `nessebar_events`, binding `ANALYTICS`, declared in both `wrangler.toml`
environments. `ANALYTICS_ENV` is the discriminator (`production` / `staging`);
never derive it from `NODE_ENV`.

Blob order is the read contract:

| blobs[0] | blobs[1] | blobs[2] | writer |
| --- | --- | --- | --- |
| `contact` | status | env | contact route (`/api/contact`) |
| event name | path | env | interaction beacon (`/api/e`) |

Contact statuses are closed: `malformed`, `unconfigured`, `ok`, `invalid`,
`rate-limited`, `rejected`, `delivery-failed`. Interaction events are the exact
allowlist in `src/analytics/events.ts`: `contact_open`, `configurator_open`,
`configurator_submit`.

No PII is ever written: no name, email, message, IP or user agent. Writes are
best-effort; a throwing `writeDataPoint` must never change a response.

## Read path

Use the **unified** SQL API, not `/accounts/<id>/analytics_engine/sql` (that
returns 403 Authorization error for every token on this account):

```
POST https://api.cloudflare.com/client/v4/analytics/sql
Authorization: Bearer <Account Analytics Read token>
{
  "query": "...",
  "scope": { "accountTag": "117232faceb06cc3cb98cedd86d59241" },
  "time_range": { "start": "...", "end": "..." }
}
```

Datasets appear as `events.analyticsEngine.nessebar_events`. Saved queries:

```sql
-- events per day by type
SELECT toStartOfDay(timestamp) AS day, blob1 AS event, count() AS n
FROM events.analyticsEngine.nessebar_events
WHERE blob3 = 'production'
GROUP BY day, event ORDER BY day DESC;

-- contact attempts by status
SELECT blob2 AS status, count() AS n
FROM events.analyticsEngine.nessebar_events
WHERE blob1 = 'contact' AND blob3 = 'production'
GROUP BY status ORDER BY n DESC;

-- top paths where the contact page was opened
SELECT blob2 AS path, count() AS n
FROM events.analyticsEngine.nessebar_events
WHERE blob1 = 'contact_open' AND blob3 = 'production'
GROUP BY path ORDER BY n DESC LIMIT 20;
```

## Known limitation

Web Analytics on the free plan has 0 rules and postfix hostname matching, so
staging (`staging.nessebarlens.com`) counts as production in WA. Either filter by
host in the dashboard or accept the inflation, and document which. AE is not
affected: `blob3` separates the environments.

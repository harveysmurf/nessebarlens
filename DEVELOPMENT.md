# Nessebar Lens — Development Practices

How we build, test, deploy, and collaborate on this site. Read this before opening a
branch or a pull request. It is the operating manual, not a wish list.

---

## 1. What this is

A minimalist photography storefront for the Old Town of Nessebar. Three galleries
(Fine Art, Archive, Film). Visitors configure a photo — size, frame, paper — see a
live price, and buy: payment is a Stripe Checkout Session, and a print is
fulfilled by Prodigi with a digitally-delivered file as the alternative. Fulfillment
is driven by the Stripe webhook, which records the order in D1.

Stack:

- **Next.js 15** App Router (React 19), built with `@opennextjs/cloudflare` and
  deployed to **Cloudflare Workers** (see §5).
- **Tailwind CSS 4** for styling. **Inter** (sans) + **Cormorant Garamond**
  (serif) are vendored locally in `src/fonts/` — builds are offline.
- **TypeScript 5**, **ESLint 9** (next/core-web-vitals), **node:test** for tests.
- Bindings: D1 `ORDERS_DB` (orders + download tokens), R2 `WEB` (public
  derivatives), R2 `MASTERS` (private masters). Stripe for payments. The KV
  `ORDERS` binding is gone: the namespace was deleted by `npm run orders:kv:remove`
  on 2026-10-03, behind a live check that no completed order was left
  unmigrated in KV. D1 is the only order store.

---

## 2. Repo & collaboration

- Origin: `git@github.com:harveysmurf/nessebarlens.git`. The Buzz repo card has no
  clone URL; use the git origin above.
- One agent owns a writable checkout at a time. For concurrent work use separate
  worktrees beside the main checkout (`REPOS/nessebarlens-wt-<branch>/`) and
  separate branches.
- **Never** discard, reset, clean, force-push, or delete another agent's branch or
  worktree without Simo's explicit say-so.
- Work on a branch, run tests, open a **GitHub** PR into `main` (§9), and announce
  it in the `nessebar-lens-website` channel. Merges happen after approval — see §9
  for who approves and what "approved" means.
- Secrets live at `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`, symlinked
  into the checkout as `.env.local`. `.env*` is git-ignored. Never commit a token.

---

## 3. Local development

The project pins its node version in `.nvmrc` (`24.21.0`, the current LTS
line). Node 20 cannot run the suite at all — it fails on `.mts` with
`ERR_UNKNOWN_FILE_EXTENSION`, because type stripping is the loader's job here.
Not every 24.x works either: **24.10 fails `tests/routes.test.mts`** on a
loader change, so `engines.node` is `>=24.21.0 <25` and every workflow pins
`node-version` to the exact `.nvmrc` value. Bump all three together
(`.nvmrc`, `engines.node`, each workflow) — `tests/node-version-pin.test.mts`
fails if they drift.

```bash
nvm use              # honours .nvmrc — do this FIRST, see below
npm install          # land under /mnt/storage, never the root fs
npm run dev          # next dev (OpenNext dev bindings auto-init)
npm run lint         # eslint
npm test             # node --test (see §4)
npm run cf-typegen   # regenerate cloudflare-env.d.ts from wrangler.toml
```

**Always `nvm use` before anything else — it is not optional and it is not
automatic.** A shell whose `node` predates the pin will run the wrong runtime and
report failures that are not the code's fault: on Node 20 the suite fails every
test file with `ERR_UNKNOWN_FILE_EXTENSION` on `.mts`, which reads exactly like
a broken rebase or a bad merge but is neither. Check with `node -v` (expect
`v24.21.0`) before trusting a red run. If the shell is non-interactive (an agent
harness, a CI step, a cron job) `nvm` may not be on the path at all — source it
first, and verify the version actually changed rather than assuming:

```bash
export NVM_DIR=/mnt/storage/apps/nvm   # not the default ~/.nvm, this is the 2TB drive
. "$NVM_DIR/nvm.sh"
cd /path/to/nessebarlens && nvm use   # reads .nvmrc; no-op + warning outside the repo
node -v                                # must print v24.21.0
```

`nvm use` prints `No .nvmrc file found` and changes nothing when run outside the
repo root — that is the other way to end up on the wrong runtime.

If `nvm` is not installed at all (some agent containers ship bare Node 20), skip
it rather than debugging the red run. Unpack the exact pin from nodejs.org into
a scratch dir on the 2TB drive and put it first on `PATH`:

```bash
PIN=$(cat .nvmrc)
cd /mnt/storage/.../scratch
curl -fsSLO "https://nodejs.org/dist/v${PIN}/node-v${PIN}-linux-x64.tar.xz"
tar -xJf "node-v${PIN}-linux-x64.tar.xz"          # extracts node-v…-linux-x64/bin/node
export PATH="$PWD/node-v${PIN}-linux-x64/bin:$PATH"
node -v                                             # must print v24.21.0
```

`linux-x64` is this box's arch; on arm64 use `linux-arm64` in all three lines.

Do not write the tarball to the repo or to `/` — `/` is nearly full on this box.

A **fresh worktree has no `node_modules`** (it is git-ignored), so run `npm ci`
once per worktree before `npm test`, `npm run lint`, or `npx tsc --noEmit`.
Without it, `npx` silently downloads a different `tsc`/`eslint` from the
registry, which fails on missing packages and looks like a config error.

Environment variables (names only — values live in the `.env.local` symlink):

| Var | Purpose |
|-----|---------|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Wrangler / OpenNext deploy auth |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `PRODIGI_API_BASE` | Explicit Prodigi host: `https://api.sandbox.prodigi.com` or `https://api.prodigi.com` (never inferred from key presence) |
| `PRODIGI_SANDBOX_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is sandbox |
| `PRODIGI_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is live |
| `PRINT_ASSET_HMAC_SECRET` | ≥32-char HMAC secret for `/api/print-asset` (Prodigi). **Required for physical checkout, not optional** — `/api/checkout` calls `canSignMasterAsset()` and answers **503** rather than take the money for a print it cannot fulfill, and `/api/print-asset` answers 503 `print-asset-unavailable` when unset. A short or whitespace-only value is treated as unset. |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin (used by `src/lib/stripe.ts`). **Required for any production build** — `next.config.ts` fails the build without it, because `NEXT_PUBLIC_*` is inlined at build time and a silent `http://localhost:3000` fallback would ship a checkout that redirects to localhost. `next dev` and `npm test` do not need it. |
| `NEXT_PUBLIC_WEB_IMAGES_BASE` | Base URL for gallery `<img>` srcset |
| `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` | Opt-in gate for the R2 derivative ladder. Unset = placeholders. Only `true`/`1` enable it — a configured base alone does **not**. |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 creds (unused by Workers — they use bucket bindings) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Needed only by `npm run ingest` from a laptop (see §6a) |
| `EU_SHIPPING_EUR` | Flat EU shipping (must match `EU_FLAT_SHIPPING_CENTS`) |

---

## 4. Testing

`npm test` runs `node --test tests/*.test.mts` — the **whole suite** — on
**node 24**, with types stripped by node itself and one resolve hook
(`tests/register.mjs` → `scripts/register.mjs` → `scripts/resolve-hooks.mjs`) for extensionless relative
imports. Tests are **Node-native, no test runner framework**.

`npm run coverage` enforces the floors in `scripts/coverage.mjs` (lines 99.95%,
branches 99.9%, functions 100%) and is a **separate CI step** — a green
`npm test` says nothing about coverage, and CI runs both.

Because stripping happens in place, `src/` must stay erasable-syntax only — no
`enum`, `namespace`, or `declare module`. `tests/resolve-hooks.test.mts` fails
the build if that ever changes, because tsc does not cover the files no test
imports.

- Always run `npm test` before opening a PR and again before a deploy.
- CI (see §6) blocks deploy on a failing test run.
- Add a test whenever you change `src/lib/order-decision.ts`,
  `src/lib/fulfillment.ts`, `pricing.ts`, or any quote/order logic.

### Preview smoke test

`scripts/smoke.sh <base-url>` is the only test that runs against a **deployed**
build. `preview.yml` runs it against the uploaded Worker Version, and a
failure fails the PR check. It asserts the pages render, the print route 404s an
unknown slug, request bodies are validated, and the HMAC/store guards are live in
the preview env (a 503 from `/api/download` means `ORDERS_DB` is not bound).

Run it locally against a build:

```bash
npx opennextjs-cloudflare build && npx opennextjs-cloudflare preview
bash scripts/smoke.sh http://127.0.0.1:8788
```

It never calls Prodigi — the live quote path is intentionally out of scope
because sandbox latency makes it flaky per-PR.

### Browser E2E flow (#143)

`npm run test:e2e` (Playwright) drives the one flow a customer takes: home →
photo → configurator → price → Stripe checkout → success page. It runs against
**`next dev`**, never the deployed preview — a preview deploy verifies a
deployment, and a smoke flow coupled to one has two possible causes for every
red run. `preview.yml` stays browser-free; the flow lives in its own
pull-request-only jobs in `ci.yml`.

**Two jobs, because half of this flow is ours to test and half is not:**

| Job | Runs | Gates? |
|-----|------|--------|
| `e2e-smoke` | the five seeded success-page states + the live-key guard | **yes** — required, and it needs no secret at all |
| `e2e-hosted-checkout` | the two specs that reach Stripe's hosted checkout page (the digital one skips itself in CI, #169) | no — `continue-on-error`, still runs, still uploads its trace |

The split is the `@hosted` tag on one describe in `e2e/smoke.spec.ts`; CI
selects on it with `--grep @hosted` / `--grep-invert @hosted`.
`tests/e2e-harness-env.test.mts` pins the arrangement, so retagging a spec
cannot quietly shrink the required coverage.

The hosted round-trip is a signal, not the proof of the flow, and it should not
be quoted as one. Stripe gates `checkout.stripe.com` behind an hCaptcha token
and an explicit "I am an AI agent" attestation; test mode changes payment
behaviour only, and neither is configurable away. The attestation asks a yes/no
question whose answer is meant to be a human's, so there is no acceptable
automated way past it. Fully automating that page means moving to the embedded
Payment Element (PCI scope change), not a CI flag. Run the hosted specs by hand
when you want to look at them; do not gate on them.

**The two hosted specs are not equally blocked (#169).** The physical-print spec
reaches Stripe and cancels — nothing is submitted, so the gate never applies and
it can genuinely pass; it is this job's real signal, so a red run means the
Prodigi quote, the checkout redirect or the cancel page regressed. The
digital-licence spec pays on that page, which is exactly what the attestation
gates, so it cannot pass on a runner. CI therefore sets
`HOSTED_DIGITAL_SKIP_REASON` and the spec skips itself with that reason, which
keeps it visible in the test list instead of hiding it behind a grep. Locally the
variable is unset and the full flow runs. The point of the change is not to hide
a red: it is to stop a guaranteed-red job from reading as noise, so the red that
is real stands out. `tests/e2e-harness-env.test.mts` pins both halves.

Needs `npx playwright install chromium` once, and three values: a **sandbox**
Stripe key, the **Prodigi sandbox** key, and any `PRINT_ASSET_HMAC_SECRET` (it
only has to sign — the flow asserts the redirect, not a download):

```bash
npx playwright install chromium
STRIPE_SECRET_KEY=sk_test_… \
PRODIGI_SANDBOX_API_KEY=test_… \
PRINT_ASSET_HMAC_SECRET=$(openssl rand -hex 32) \
npm run test:e2e
```

The dev server Playwright starts gets all three, plus a **pinned**
`PRODIGI_API_BASE=https://api.sandbox.prodigi.com`. Prodigi is explicit-host by
design, so without that host `/api/quote` answers 503; without the HMAC secret
`/api/checkout` fails closed with 503 "Print fulfillment is not configured". Both
make the physical-print spec wait on a Checkout button that can never enable,
which reads as a Prodigi outage rather than a missing variable.
`tests/e2e-harness-env.test.mts` pins all of it.

Without a key the Stripe specs **skip themselves** and only the success-page
states run — a partial pass that looks green. The hosted job fails outright
instead, and asserts the key is `sk_test_` before spending anything. The Prodigi
sandbox key is guarded the same way, because the physical-print spec skips
itself without it and would leave the Prodigi-quoting path untested. The
required job needs neither guard: everything it runs is seeded, so there is no
key whose absence could turn a spec into a green skip.
`e2e/support/stripe.ts` throws on a non-test key before a browser starts, so a
live key is refused rather than warned about.

The success page's three states are **seeded** rather than reached through the
webhook: the D1 a dev server gets from
`initOpenNextCloudflareForDev` is genuinely empty, so a dev server can only ever
render "processing". `playwright.config.ts` sets `ORDERS_DEV_SEED` to
`e2e/fixtures/orders-seed.json`, which `src/lib/orders-dev-seed.ts` serves
in-memory. The seed takes precedence over the dev namespace when the flag is
set, and that module refuses to run under `NODE_ENV=production`, so fabricated
orders can never reach a deployed build. The webhook's own round trip is a
separate handler-level concern and is not covered here — see §10.

To see a seeded state by hand:

```bash
ORDERS_DEV_SEED=e2e/fixtures/orders-seed.json npm run dev
# then open /checkout/success?session_id=cs_test_e2edigitalpaid00000001
```

---

## 5. Build & deploy

Canonical path is **GitHub Actions** (§6). Manual deploys are for break-glass only.

### Preview (PR / feature branch)

```bash
SITE_URL=https://dev.nessebar-lens.pages.dev npx opennextjs-cloudflare build
SYNC_SCOPE=version-only SECRETS_OUT=preview-secrets.json \
  bash scripts/sync-worker-secrets.sh preview
npx opennextjs-cloudflare upload \
  --secrets-file=preview-secrets.json \
  --tag="pr-<number>-<branch>" --message="preview PR #<number>"
rm -f preview-secrets.json
```

A preview is a **Worker Version**, addressed by id: `preview.yml` resolves the id
from the tag it just set (`wrangler versions list --json`) and both the smoke test
and the PR comment use `https://<version-id>.<subdomain>.workers.dev`. There is no
branch alias — a version URL stops resolving when the version is deleted, which
`preview.yml` does on PR close.

The version id is read from `versions list` rather than scraped from upload
output because that output is not a contract and has changed shape across
wrangler releases.

`--secrets-file` is not optional. A Worker keeps one secret store per version, so
a preview that synced secrets separately would write the sandbox Stripe key over
the live one and take production down until the next deploy. Attaching the
secrets to the version being uploaded is what keeps a preview isolated from the
deployed site.

### Production (main only)

```bash
SITE_URL=https://nessebarlens.com npx opennextjs-cloudflare build
SYNC_SCOPE=version-only SECRETS_OUT=prod-secrets.json \
  bash scripts/sync-worker-secrets.sh production
npx opennextjs-cloudflare deploy --secrets-file=prod-secrets.json
rm -f prod-secrets.json
```

Secrets go on the version being deployed, in the same step. Do **not** "deploy
then sync" — that reads naturally and is wrong. `wrangler versions secret bulk`
PATCHes `versions/latest`, which mints a *new* version rather than editing the
deployed one, so a post-deploy sync leaves a rotated key on a version that never
serves: green run, production still on the old key. Syncing first is wrong the
other way, describing a version the deploy then replaces.

`--secrets-file` has no window at all, and it is the same mechanism previews use,
so there is one thing to reason about rather than two.

Production and preview both target the **same Worker**, `nessebar-lens`, and are
separated by version rather than by project. Apex `nessebarlens.com` / `www`
CNAME to the Worker (see the cutover checklist below).

### Rotating a secret (no rebuild)

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

This updates the deployed Worker directly. It is the one capability Pages did not
have and the reason #115's "secrets without a rebuild" acceptance criterion is
met: on Pages a rotated key needed a full build and redeploy to take effect.

### Cutover checklist: Pages → Workers

Only the account owner can do these. They are ordered so that a rollback never
strands a paid order — **DNS is flipped last**, and the webhook is flipped only
after the new Worker is verified serving.

1. **Verify the Worker serves before anything customer-visible moves.**
   `npx wrangler deploy`, then confirm `https://<subdomain>.workers.dev` answers
   and `/api/download` is not 503 (that 503 means `ORDERS_DB` D1 is not bound).
2. **Attach the bindings.** `wrangler.toml` declares ORDERS_DB D1 and WEB/MASTERS R2;
   confirm all three are bound on the deployed Worker, not only in config.
3. **Flip the Stripe webhook endpoint** to the Worker URL, in the Stripe Dashboard.
   Do this *before* DNS: it is the step that can take money, and doing it while
   the old Pages host still answers means no order is lost during the swap.
4. **Flip DNS** — apex `nessebarlens.com` and `www` CNAME to
   `<subdomain>.workers.dev`. Lower the TTL at least one full TTL *before* this
   step, not after, or the rollback below waits out the old record.

**Rollback, in reverse: restore the Stripe webhook URL first, then the DNS
records, then redeploy the previous Worker version** (`wrangler versions deploy
<previous-version-id> --percentage 100`). A code revert alone is not a rollback —
DNS and the webhook endpoint live outside the repo, and a paid order that lands on
a host serving a reverted build is a support incident, not a deploy.

### Wrangler config invariants (`wrangler.toml`)

- `main = ".open-next/worker.js"`.
- `[assets]` `binding = "ASSETS"`, `run_worker_first = true`.
- Do **not** set `pages_build_output_dir` — that makes Wrangler treat the config as
  a Pages config where `ASSETS` is reserved.
- R2 S3 access keys are unused; Workers use bucket bindings only (`WEB`,
  `MASTERS`). `ORDERS_DB` D1 + WEB/MASTERS R2 are attached on the Worker.
- The KV `ORDERS` binding **no longer exists**. It was a one-shot migration
  leftover: `npm run migrate:orders` read it through the wrangler CLI, and
  `npm run orders:kv:remove -- --yes` deleted the namespace on 2026-10-03 once a
  live check confirmed D1 held every completed order. Deleting the namespace by
  hand before that check is how the source data is lost; the gate is what made
  the removal safe, so never hand-delete it.
- `[[d1_databases]]` binding `ORDERS_DB`, database `nessebar-lens-orders`,
  `migrations_dir = "migrations"`. The `database_id` is committed; the database
  exists and `migrations/` is applied. Re-create only if the account is reset —
  see the D1 subsection below.
- Do **not** add `[triggers] crons`. OpenNext's generated
  `.open-next/worker.js` exports only `default { fetch }` plus the DO classes,
  so a cron trigger would be silently ignored. The reconciler is a Next route
  invoked by GitHub Actions (`.github/workflows/reconcile.yml`).
- `preview_id` on a KV binding is a **KV namespace** preview id (`wrangler dev`),
  not a Pages preview-deployment concept. `scripts/remove-orders-kv.mjs` read and
  deleted both ids from the (now removed) `ORDERS` block.
- Runtime secrets (Stripe/Prodigi/RECONCILE_SECRET) live as **Worker secrets**, scoped per version.
  Sync with `scripts/sync-worker-secrets.sh`; rotate with `wrangler secret put`.
  `NEXT_PUBLIC_*` bake at build from GitHub Environment secrets and are
  deliberately not in the secret map — a `NEXT_PUBLIC_*` entry there would be a
  value that looks live and never changes.

### D1 orders database

Already created and applied — these are only for a fresh account:

```bash
npx wrangler d1 create nessebar-lens-orders
# paste the id into wrangler.toml [[d1_databases]].database_id
npx wrangler d1 migrations apply nessebar-lens-orders --local
npx wrangler d1 migrations apply nessebar-lens-orders --remote
```

**The migration has run.** On 2026-10-03, against main `e6227b2`:

```
tally {"inserted":5,"skippedExisting":0,"corrupt":0,"tokensMigrated":0}
wrangler kv key list --binding ORDERS --remote   -> 5 keys
select count(*) from orders                       -> 5
select count(*) from download_tokens              -> 0
```

`corrupt: 0` — `parseOrderRecord` accepted every real KV record, so there is no
schema drift between the KV-era payloads and the D1 columns. `tokensMigrated: 0`
is consistent: no download token had been minted under KV yet. **D1 is now the
authoritative order history and the reconciler has something to recover.**

KV held the same 5 keys and the `ORDERS` binding stayed in `wrangler.toml` as
the rollback path until the removal landed. It landed on 2026-10-03 (see
"Removing the ORDERS KV namespace" below); the KV namespace no longer exists.

One-shot KV → D1 migration, idempotent, re-runnable (the KV namespace is gone;
this only runs against an account whose namespace still exists):

```bash
npm run migrate:orders            # INSERT … ON CONFLICT DO NOTHING
npm run migrate:orders -- --overwrite
```

**Node ≥ 22 is required** (wrangler refuses to run on v20) and the script needs
the resolve hook — `scripts/register.mjs` → `scripts/resolve-hooks.mjs`, which
`package.json` already passes via `--import`. The script imports `src/lib/*.ts`,
whose own imports are extensionless, so without the hook node raises
`ERR_MODULE_NOT_FOUND` and nothing runs (#177). If you invoke the script
directly rather than through npm, pass the same flag:

```bash
node --import ./scripts/register.mjs scripts/migrate-orders-kv-to-d1.mjs --help
```

**Every read of a production KV namespace needs `--remote`, explicitly.**
`wrangler kv key list/get` resolves a binding against *local* storage unless
`--remote` is passed, so an omitted flag returns `[]` / `""` on any machine that
has not run `wrangler dev` — no error, exit 0. The failure mode is silent: a
migration then reports a zero tally and looks like it worked. Compare:

```bash
wrangler kv key list --binding ORDERS --prefix ""            # -> []        (local)
wrangler kv key list --binding ORDERS --prefix "" --remote   # -> cs_test_… (real)
```

Treat a missing `--remote` on any `wrangler kv …` read as a bug, not a
style nit. This bit `scripts/migrate-orders-kv-to-d1.mjs` and the fix is
`fix/175-migrate-reads-remote` (#176).

### Removing the ORDERS KV namespace

**Done on 2026-10-03** (`#178`): both namespaces are deleted and the
`[[kv_namespaces]]` block is gone from `wrangler.toml`. D1 is the authoritative
order history. `scripts/remove-orders-kv.mjs` did it, behind a gate that runs
*in the same process, immediately before anything is touched*:

```bash
npm run orders:kv:remove           # checks coverage, refuses
npm run orders:kv:remove -- --yes  # removes only if the gate passes
```

The invariant is "no unmigrated completed order remains in KV". The gate
measures, live:

```
select session_id from orders              (wrangler d1 execute --remote)
wrangler kv key list --namespace-id <id> --remote   -> key names
wrangler kv key get <cs_…> --namespace-id <id> --remote -> value
```

A KV key matters only if the migrator's own grammar says it is an order —
`classifyKvKey` for the key, `looksLikeOrderRecord` for the value — so
`cs_test_` pre-payment placeholders and `dl:`/`dls:` download-token keys are not
orders and are not fetched. Every order-valued key must have a D1 row; the first
that does not exits 1 naming the session ids and **nothing is deleted**. Both the
production and preview namespaces are checked. A D1 result it cannot parse is a
failed gate, not an empty set, and `--yes` is required even when the check is
clean, so a bare invocation is a no-op. A check written as a comment would be a
check against a claim that may have gone stale — a namespace can receive new
orders between the migration and the deletion.

On success it deletes the production and preview namespaces, then rewrites
`wrangler.toml` to drop the `[[kv_namespaces]]` block. Order matters: the
config is rewritten *last*, so a failed delete leaves the ids on record. If the
script finds no `ORDERS` binding it exits 1 rather than reporting success,
because that state means an earlier run died mid-way.

Operator view (CLI, not an admin route — this Worker serves customers):

```bash
npm run orders -- --status paid-unfulfilled --limit 50
```

### Reconciler

`POST /api/internal/reconcile`, guarded by `x-reconcile-secret` /
`RECONCILE_SECRET`. Triggered every 15 minutes by
`.github/workflows/reconcile.yml`, and on demand via `workflow_dispatch`
(force a run after rotating a Prodigi key). It retries paid-unfulfilled
non-terminal orders through the same `fulfillCheckoutSession` the webhook
uses, recovers paid Stripe sessions with no stored order, and logs
`order.stuck` for #100.

GitHub Actions scheduled workflows are best-effort AND auto-disable after
60 days of repository inactivity, so for a print site that can sit quiet in
maintenance mode "the reconciler silently stopped" is a real latent risk.
The failure mode is a later run, not lost money, so this is acceptable now.
The upgrade path is a separate Cloudflare-Cron worker, or a trigger-shim
worker that only calls the route.

---

## 6. CI/CD

GitHub Actions on `harveysmurf/nessebarlens` (Node 24.21.0, see §3):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `.github/workflows/ci.yml` | PR + push to `main` | `npm ci` → lint → typecheck → test → **coverage floors**; plus a `workflow-audit` job (**install zizmor** → **gate on workflow script injection**, scoped to `template-injection` at Medium confidence and up — the other 40 findings are reported, not gated); plus two pull-request-only browser jobs — **required** `e2e-smoke` (no secrets: `npm ci` → **install chromium** → **e2e smoke flow (seeded)**: `npm run test:e2e -- --grep-invert @hosted` → **upload the failure trace** on failure) and **best-effort** `e2e-hosted-checkout` (`continue-on-error`; staging Environment → **install chromium** → **require a stripe test key** → **require a prodigi sandbox key** → **e2e hosted checkout** (`npm run test:e2e -- --grep @hosted`, headed under Xvfb) → **upload the trace** every run) |
| `.github/workflows/preview.yml` | PR open/sync | staging Environment → build → **Worker Version upload** (secrets attached via `--secrets-file`) → **smoke test** the version URL (`scripts/smoke.sh`) → PR comment; `versions delete` on close |
| `.github/workflows/prod.yml` | push to `main` + `workflow_dispatch` | production Environment → checks (`ci.yml`) → build → `opennextjs-cloudflare deploy --secrets-file` (guards run first in `version-only` mode) |

### The workflow audit job

`ci.yml` runs [zizmor](https://docs.zizmor.sh/) through
`scripts/zizmor-gate.mjs`, and the gate is **scoped**: it fails only on
`template-injection` findings at Medium confidence or above. Everything else
zizmor reports is printed and not gated, with the reason inline.

That scoping is the whole design. A bare `zizmor` run used to be far from green
on this repo, and no `--min-severity` / `--min-confidence` / `--persona`
combination made it green — 40 other findings, mostly `unpinned-uses` and
`excessive-permissions`, were real work that had nothing to do with the
injection class. Bundling them into a security fix on workflows that deploy
would have made it a large unrelated change; gating on them would make the job
permanently red, and a red gate nobody can satisfy is a gate everyone learns to
skip.

`#165` has since cleared all four of those classes: every action is SHA-pinned,
every workflow declares `permissions: contents: read`, every checkout sets
`persist-credentials: false`, and same-repo references use `$/`. What remains
advisory today is 3 Low/Informational `template-injection` findings — the same
sanitized interpolations the confidence floor exists to tolerate — so the gate's
scope is still correct rather than merely historical.

The confidence floor is not decoration. After the `env:` fix the only remaining
`template-injection` findings are the sanitized `steps.branch.outputs.name`
interpolations, which zizmor rates Low/Informational because it cannot trace the
value back through `scripts/sanitize-branch-name.sh`. Measured with zizmor
1.30.1 on this repo:

| | `template-injection` |
|---|---|
| before the `env:` fix | 2 × High/High + 6 × Low/Informational → **gate fails** |
| after it | 0 at Medium or above + 6 × Low/Informational → **gate passes** |

So: do not raise the persona to `auditor` or `pedantic`. Both promote those
sanitized findings to High confidence, which puts them back in the gate and
reopens exactly the false red the floor exists to prevent.

The rule is `template-injection` only — an untrusted expression (branch name, PR
title/body, commit message, or a composite action's own input) evaluated as
workflow-level shell source. The fix is always the same: pass it through `env:`
and let the shell quote it. `tests/workflow-injection.test.mts` is the
belt-and-braces source scan; this job is the one that knows about inputs zizmor
understands and the test's hand-written list does not.

Run it locally with zizmor on `PATH`:

```
npm run lint && node scripts/zizmor-gate.mjs
```

### Rotating a credential

Two paths, and the difference matters during an incident.

**No rebuild (preferred).** `wrangler secret put <NAME>` PATCHes the deployed
Worker in place, so the new value is live as soon as the command returns:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

This is a capability Pages did not have — Pages `env_vars` are frozen into a
deployment, so a rotated key there needed a full build and redeploy to take
effect. That constraint is what the deleted sync-without-deploy workflow existed
to work around, and why it was a silent-failure trap.

**Through CI.** Update the GitHub Environment secret, then **Run workflow** on
`prod.yml` (`workflow_dispatch`). This rebuilds and redeploys, carrying the
secrets on the deploying version via `--secrets-file`.

Prefer the first unless the rotation is bundled with a code change — a deploy
also picks up whatever else is on `main`, which is not something you want
happening while you are rotating a key under pressure.

Do **not** reach for `bash scripts/sync-worker-secrets.sh production` expecting
the deployed version to change: its default scope mints a new version rather than
editing the one serving traffic.

Expect a few minutes between merge and the deploy starting — that is GitHub
Actions queue latency, not a dropped run. Check the Actions tab before
re-dispatching.

GitHub Environments:

- **`staging`** — sandbox Stripe + `PRODIGI_API_BASE=https://api.sandbox.prodigi.com` +
  `PRODIGI_SANDBOX_API_KEY` + `SITE_URL=https://dev.nessebar-lens.pages.dev`.
  The `e2e-hosted-checkout` job also reads its keys from here, so it needs
  `environment: staging` — the repository has only `PRINT_ASSET_HMAC_SECRET`, and
  without the environment line every guard would resolve to nothing. Its one
  Stripe key is the `sk_test_` sandbox one, which the job's `sk_test_*` guard
  enforces before anything is spent. The required `e2e-smoke` job reads no
  secret at all, which is why it still runs on fork pull requests where GitHub
  withholds them.
- **`production`** — required reviewer `harveysmurf`. Live Stripe
  (`sk_live_*` + live webhook secret) + `PRODIGI_API_BASE=https://api.prodigi.com` +
  `PRODIGI_API_KEY` (live org key). Host is never inferred from which key is set.
  Preview/staging stays sandbox.

Secrets live in those Environments (never in git). Local `.env.local` remains the
Debian-host symlink to `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`.

---

## 6a. Ingesting photos (masters → R2 ladder)

Simo runs this from his own box, not CI. Three prerequisites, in order:

1. **Node 24.21** — `nvm use` in the repo root. `npm run ingest` checks the
   pin in `.nvmrc` and stops with `ingest needs Node 24.21.0` otherwise,
   because `sharp` is a native binding and a mismatch otherwise surfaces as an
   opaque `ERR_UNKNOWN_FILE_EXTENSION`.
2. **`npm install`** — `sharp` and `@aws-sdk/client-s3` are devDependencies
   only the ingest uses; the site itself never imports them.
3. **R2 credentials in `.env.local`** (gitignored) or exported:

   ```
   R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   ```

   From Cloudflare → R2 → Manage R2 API Tokens → *Object Read & Write* scoped
   to `nessebar-lens-masters` and `nessebar-lens-web`. The workspace copy of
   these lives in `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`.
   Missing keys fail as `missing env: R2_ACCESS_KEY_ID ...`, never as a 403.

Then, per photo:

1. Drop the master JPEG in `ingest/` (repo root, gitignored), **named for its
   slug** — `alley-cat.jpg` is the catalog slug `alley-cat`. Files not matching
   `{slug}.jpg` are reported and skipped, so a `.DS_Store` or `IMG_4021.jpg`
   cannot become an unlinkable photo.
2. `npm run ingest` — **dry run by default.** It prints every object it would
   write, in both buckets, and uploads nothing. Read that list.
3. `npm run ingest -- --apply` — writes the original to
   `nessebar-lens-masters/prints/{slug}.jpg` and each rung to
   `nessebar-lens-web/{slug}/{750,1500,2500}.jpg`. Width-driven resize, aspect
   ratio preserved, no crop: the list page's uniform tiles are a CSS
   `aspect-ratio` with `object-fit: cover`, and the photo page is uncropped.
   `--only alley-cat` narrows a run to one photo.
4. Verify a couple of URLs resolve under `NEXT_PUBLIC_WEB_IMAGES_BASE`, **then**
   set `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED=true`. Only `true` or `1` enable
   the ladder; a configured base alone does not.

Idempotent — re-running overwrites the same keys with the same bytes. The run
**refuses outright** if `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` is set, because at
that point the site is already serving this bucket and a half-written ladder
would 404 the storefront. Turn the flag off, ingest, verify, then turn it on.

The rung list is `WEB_DERIVATIVE_WIDTHS` in `src/lib/derivative-ladder.ts` —
one array, read by both the srcSet the site serves and the plan the script
executes. Changing the rungs is a one-line edit there; do not add widths in the
script.

---

## 7. Data flow & invariants

- **Catalog is the single source.** `src/lib/photos.ts` `PHOTOS` array holds every
  photo (`slug`, `title`, `category`, `imageKey`, `fromPriceEur`, …). The only
  master-key list is `photos.ts` `imageKey`, surfaced via
  `src/lib/master-key.ts` `masterKeyForSlug()`.
- **Placeholders.** `public/placeholders/{slug}.jpg` are 20 local stand-ins
  (7 fine-art, 7 archive, 6 film). Gallery images resolve to
  `/placeholders/{slug}.jpg`; real photographs replace these on R2 later. Keep the
  slug set stable.
- **No remote image hosts.** `next.config.ts` sets `images.remotePatterns: []` —
  do not add `images.unsplash.com` or any third-party host. Gallery uses plain
  `<img>` srcset against `NEXT_PUBLIC_WEB_IMAGES_BASE` only.
- **The derivative ladder is gated.** `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED`
  (default off) decides between the R2 ladder (`{slug}/{width}.jpg` in
  `nessebar-lens-web`) and the committed placeholders. Set the base without the
  flag and the gallery keeps serving placeholders — that is deliberate, because
  the base is configured in every environment while both buckets are still
  empty. Turn the flag on only after the upload is verified, and expect
  `tests/placeholder-photo.test.mts` to need updating at that moment.
- **Quotes are cached; checkout is not.** `/api/quote` is unauthenticated and
  shares Prodigi's rate limit with `/api/checkout`, so a cached-miss loop could
  otherwise 429 Prodigi and break checkout for real customers. `src/lib/quote-cache.ts`
  caches the two public numbers (`merchandiseEur`, `shippingEur`) per
  `(SKU, attributes, destinationCountry)` for 30 minutes in `caches.default`.
Three invariants: (1) `sku` and `unitCostEur` never enter the cached
   *value* — the wholesale cost and the margin stay server-side. (The `sku`
   necessarily appears in the cache *key*, which is server-side on an `.invalid`
   origin and never returned to a caller); (2) `/api/checkout` keeps
  quoting live, so the price charged is the price Prodigi just returned; (3) any
  cache error degrades to a live quote, never to a 5xx. Covered by
  `tests/quote-cache.test.mts` and `tests/routes.test.mts`.
- **Rate limit on `/api/quote`.** The application-level cache above is the
  defence that needs no dashboard access; the Cloudflare WAF rule is the second
  layer and is **configured in the dashboard, not in this repo** (Wrangler does
  not manage rate-limit rules). Zone `nessebar-lens.com`: Rate Limiting Rules →
  expression `http.request.uri.path eq "/api/quote"`, characteristic `ip.src`,
  30 requests / 1 minute, mitigation `block`, period 60s. If the zone has no
  rate-limit plan, the equivalent is a WAF custom rule with
  `cf.ratelimit.counting_period eq 60`. Nothing in CI verifies this — if you
  change the threshold, update it here too.
- **Stripe Checkout only.** `/api/checkout` creates a Checkout Session
  (`success_url` / `cancel_url`); no code path confirms a PaymentIntent. Stripe
  sandbox emails about a missing `return_url` are expected after manual
  `paymentIntents.confirm` probes — ignore them.
- **Stripe webhooks** are verified with Web Crypto (`src/lib/stripe-event.ts`), and
  master keys are read from `photos.ts` (commit `cdac0eb`).
- **Fulfillment is recorded, not executed.** The rules live in
  `src/lib/order-decision.ts` (pure: what a session means, what a stored record
  says, whether a customer may download) and the effects in
  `src/lib/fulfillment.ts`, which writes the
  order to D1 `ORDERS_DB`. A *retryable* failure (Prodigi 401/403/429/5xx, an
  unconfigured key or asset secret) is written `terminal: false` and the webhook
  answers 5xx so Stripe redelivers for ~3 days; a terminal one answers 200. The
  record's `reason` says which, so an operator can tell "rotate the key" from
  "back off" from "fix the deploy". No auto-refund: a stuck paid order is
  alerted for a human.
- **Every unfulfilled order logs.** `fulfillCheckoutSession` writes through
  `storeOrder`, the only ORDERS write in the order path, which emits one
  structured `console.error` whenever the stored record is `paid-unfulfilled`:
  `{"event":"order.unfulfilled","sessionId","reason","terminal","format"}`, plus
  `"detail"` carrying the upstream message on a retryable Prodigi failure.
  Find them with `wrangler tail` on the production worker, or in Cloudflare
  **Workers Logs** filtered on `order.unfulfilled`; locally, run `npm test` and
  read stderr. `AWAITING_PRODIGI_REASON` is excluded — it is an internal marker
  rewritten by the same call, not an outcome. Operator view: `npm run orders`.
- **One payment, one Prodigi order.** `idempotencyKey` is the Stripe session id, so
  a redelivery that re-attempts gets Prodigi's `alreadyExists` with the original
  order rather than a second print.
- **Own your config errors.** A misconfiguration of *our* deploy must never
  surface as an upstream 502/500. Two corollaries:
  1. Read config getters (`prodigiApiKey`, `prodigiOrdersUrl`, `prodigiQuotesUrl`)
     **before** the request — never inside the `fetch()` argument list, where a
     throw skips the try/catch that translates it.
  2. Every "we are not configured" path produces a **distinct, retryable reason**
     and a **503**, so the record and the log say *what* is unset.

  `isProdigiUnconfigured` is the single predicate for "our fault, not Prodigi's";
  a new config error that does not match it silently becomes a 502.

- **Shipping constant coupling.** `eurToCents` in `pricing.ts` is the one EUR→cents
  rounding in the repo — Stripe line items, the webhook's amount check and the
  stored record must not each redefine it.

---

## 8. Code conventions

- **No comments in code** unless the repo already documents a hard invariant — the
  existing `fulfillment.ts` / `wrangler.toml` comments are deliberate and stay.
- Follow existing module boundaries: `src/lib/*` for logic, `src/app/api/*` for
  routes, `src/components/*` for UI, `src/app/*/page.tsx` for pages.
- TypeScript strict; run `npm run lint` before committing.
- Fonts are vendored; never pull them from a CDN at build time.

### One source per grammar and per shape

Any regex or object type that encodes a rule is declared in **one** module and
imported everywhere else. Tests do not catch a divergent copy while the copies
still behave the same, and that is exactly how two bugs got here: the
master-marker regex and the photo-slug grammar each grew a private second copy
that agreed until it did not.

Owners: `master-key.ts` (slug, master key, MASTERS storage shape),
`master-guard.ts` (master marker), `crypto-hex.ts` (hex signature),
`ship-to-countries.ts` (ISO alpha-2), `url-patterns.ts` (absolute https).

`tests/single-source-grammar.test.mts` enforces this by walking the TypeScript
AST — a regex in a string or a comment is not mistaken for a declaration. It
fails on any regex literal or object shape that appears in two modules.

The guard only sees **syntactic** duplicates. It cannot see two grammars that
mean the same thing but are written differently — `/^https:\/\//i` next to
`URL.canParse(x)` is one rule wearing two coats, and the guard stays green. That
is a naming and design problem, not a lint problem: treat "this belongs to an
existing owner module" as intent you have to apply by reading the code, and use
the guard to keep the honest copy honest.

---

## 9. Release checklist

1. Branch off `main`.
2. Make the change; add/adjust tests in `tests/`.
3. `npm run lint` and `npm test` green locally.
   Run `git status --short` before committing: `git commit -a` stages only
   *tracked* files, so a brand-new module can pass locally and fail CI on a
   missing import. This repo has shipped one red build that way.
4. Push the branch and open a **GitHub** PR into `main`.
5. Wait for CI + staging preview (PR comment with a `*.workers.dev` version URL).
6. Announce the PR + preview URL in `nessebar-lens-website`; get approval.
7. Merge to `main` → production workflow runs (GitHub Environment approval by
   `harveysmurf`) → https://nessebarlens.com.
   **Squash a multi-commit PR into one commit on main.** A refactor branch
   accumulates a commit per idea, and main is the place someone reads to learn
   what a module is *for* — a ten-commit trail of "move this, tighten that"
   turns the history into a changelog of mechanics. The one-line rule of thumb:
   if the individual commit subjects do not each make sense as a description of
   the resulting code, squash.
8. Report the PR link, preview URL, and commit hash in the channel.

---

## 10. Known state / open items

- Brand rename "Stefan Todorov" → "Nessebar Lens" is done (commit `18886c3`); keep
  "Old Town Nessebar" as the place name.
- Prodigi order creation is wired end to end: a pinned 9-SKU map (`src/lib/sku-map.ts`),
  live quote + order calls, and a HMAC-signed master asset URL. Sandbox and live
  are selected by an explicit `PRODIGI_API_BASE`, never inferred from the key.
- Real photographs still need to land in the R2 `MASTERS`/`WEB` buckets to replace
  the 20 placeholders. `npm run ingest` (§6a) does that; the ladder stays off
  until the upload is verified.
- If a 502 shows up from `/api/quote` or `/api/checkout` and it is *not* Prodigi
  being down, look at `prodigiErrorStatus` first. 503 means this deploy is
  misconfigured (unset Prodigi key, or a `PRODIGI_API_BASE` outside the two
  allowed hosts); 502 means Prodigi. The split is exact string equality against
  the messages `src/lib/prodigi-config.ts` throws, so a *new* throw site that
  forgets to be classified reports a deploy problem as a bad gateway.
  `tests/prodigi-config.test.mts` enumerates them; that is the file to extend
  when the module gains one.
- `PRODIGI_SHIPPING_METHOD` ("Budget") is the value we quote and buy with, and
  no unit test can confirm Prodigi still accepts that string for the pinned SKUs.
  It is a sandbox check, not a test.
- The Stripe **webhook round trip is not covered end to end** (#143). The browser
  flow seeds ORDERS rather than standing up a receiver, so what the suite proves
  is "the page renders every state", not "the webhook writes them". The right
  coverage is a handler-level test against the dev Worker env — mock the Stripe
  signature, POST to `/api/webhooks/stripe`, assert the record. It does not
  exist yet; log it rather than folding it into the browser smoke, which would
  put signature timing and a network loop into a job that should stay cheap.

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
| `PRODIGI_WEBHOOK_TOKEN` | Bearer token Prodigi must send on `POST /api/webhooks/prodigi` (`Authorization: Bearer …`). Prodigi v4 signs nothing, so this is the only callback auth. **Unset ⇒ 503** `prodigi-webhook-unconfigured`; mismatch ⇒ 401. Generate with `openssl rand -hex 32` and configure the same value as the shared secret Prodigi is told to send (or that a reverse-proxy injects). |
| `RESEND_API_KEY` | Resend API key for customer email (order confirmation, print shipped, unfulfilled apology). **Unset ⇒ emails are skipped** with a structured `email.skipped` log line — never a throw on a paid webhook path. The sending domain (`nessebarlens.com`) must have Resend's **DNS TXT domain verification** before production mail will deliver; until then sandbox/`onboarding@resend.dev` testing is fine locally. |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin (used by `src/lib/stripe.ts`). **Required for any production build** — `next.config.ts` fails the build without it, because `NEXT_PUBLIC_*` is inlined at build time and a silent `http://localhost:3000` fallback would ship a checkout that redirects to localhost. `next dev` and `npm test` do not need it. |
| `NEXT_PUBLIC_WEB_IMAGES_BASE` | Base URL for gallery `<img>` srcset |
| `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` | Opt-in gate for the R2 derivative ladder. Unset = placeholders. Only `true`/`1` enable it — a configured base alone does **not**. |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 creds (unused by Workers — they use bucket bindings) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Needed only by `npm run publish-photos` from a laptop (see §6a) |
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
- `tests/stripe-contract.test.mts` runs recorded Stripe webhook fixtures through the
  installed SDK with no secrets (#225); see "Dependency updates".
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

`next.config.ts` initialises those dev bindings **only when
`NODE_ENV=development`** (#227): `next build` evaluates the same config in every
prerender worker, and an unguarded `initOpenNextCloudflareForDev` makes each of
them boot a local Workers runtime on the shared `.wrangler/state` SQLite file —
the `SQLITE_BUSY` that failed `Build (production)` and blocked deploys. In CI
the dev bindings are also `persist: false`, so the more-than-one `next dev`
process cannot race on that file either; the smoke flow reads only the in-memory
seed, so nothing needs to survive. `tests/no-workerd-in-build.test.mts` pins
both.

To see a seeded state by hand:

```bash
ORDERS_DEV_SEED=e2e/fixtures/orders-seed.json npm run dev
# then open /checkout/success?session_id=cs_test_e2edigitalpaid00000001
```

### Live Stripe API verification (#101, #134)

`scripts/verify-stripe-integration.mjs` checks the two API shapes the
refund/dispute revocation path (`src/lib/order-revocation.ts`) is written
against and that no stub can prove: that
`checkout.sessions.list({payment_intent})` returns the session a payment came
from, and that a dispute names a Charge id whose `payment_intent` leads back to
the order. It runs the real test-mode API and is deliberately **not** in
`ci.yml` — it creates real objects in the Stripe test environment, so
`verify-stripe.yml` schedules it on its own.

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/verify-stripe-integration.mjs
```

It refuses any key that is not `sk_test_` before spending anything.

**It needs at least one completed Checkout Session to exist in the account**
(#134). Completing a Checkout Session has no server-side API — the hosted page
is the only completion path, and `POST /v1/checkout/sessions/{id}/complete`
plus `POST /v1/disputes`, which the first version of this script used, both
answer 404 `Unrecognized request URL` on every Stripe API version. So the
lookup is verified against a real completed session already in the account, and
the dispute is raised the documented way: paying with the
`pm_card_createDispute` test PaymentMethod makes Stripe open it. A new test
account with no completed session fails that one check with the fix in the
message — run `npm run test:e2e`, or complete one test checkout by hand.
`tests/verify-stripe-script.test.mts` pins the decisions the script makes about
which session, which dispute and which refund order.

---

## 5. Build & deploy

Canonical path is **GitHub Actions** (§6). Manual deploys are for break-glass only.

### Preview (PR / feature branch)

```bash
SITE_URL=https://staging.nessebarlens.com npx opennextjs-cloudflare build
SYNC_SCOPE=version-only SECRETS_OUT=preview-secrets.json \
  bash scripts/sync-worker-secrets.sh preview
npx opennextjs-cloudflare upload \
  --env staging \
  --secrets-file=preview-secrets.json \
  --tag="pr-<number>-<branch>" --message="preview PR #<number>"
rm -f preview-secrets.json
```

**`--env staging` is not optional (#202).** Without it the upload targets the
top-level Worker, `nessebar-lens` — the production one — and the version
inherits its bindings: `ORDERS_DB` = `nessebar-lens-orders` and `MASTERS` = the
real masters bucket. A preview runs unreviewed PR code, so a sandbox purchase
made on one wrote to the production orders table next to real ones (the
`cs_test_` rows the 2026-10-04 audit turned up). With it, a preview is a version
of `nessebar-lens-staging` and binds `nessebar-lens-orders-staging`. The same
applies to the cleanup job's `wrangler versions list`/`delete`, which must name
the environment the upload used or they query production, match nothing, and
report success.

The upload step asserts the reported preview URL is a
`<8-char-id>-nessebar-lens-staging.<sub>.workers.dev` hostname and fails
otherwise. `--env staging` in the source is the flag; the hostname is the
*observable* — a green upload proves a version exists, not which worker it
belongs to.

**One account setting this depends on: version previews must be enabled for
`nessebar-lens-staging`.** wrangler only prints `Version Preview URL` when the
worker's subdomain settings have `previews_enabled` (`result.metadata.has_preview`
→ `subdomain.previews_enabled` in its publish output), and a version with no
preview URL is unreachable by URL — the upload lands a version nothing can call.
Staging was created with a `custom_domain` route and has never had previews on, so
the upload step now fails with that named as the cause rather than a generic
"no version id / preview URL". Enable it once (Dashboard → Workers →
`nessebar-lens-staging` → Settings → Version Previews, or
`POST /accounts/<id>/workers/scripts/nessebar-lens-staging/subdomain` with
`previews_enabled`). It is deliberately not done from `preview.yml`: that job runs
unreviewed `pull_request` code with the staging Cloudflare token, so it must not be
the thing that mutates Worker settings.

Version previews for `nessebar-lens-staging` were enabled 2026-10-05 (as the
unblock for #224), so a preview upload now prints a `Version Preview URL` and
`preview.yml` proceeds past the "no preview URL" branch. If a preview reds with
"wrangler printed no Version Preview URL" again, re-check this setting first —
it is an account state, not code.

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

### Staging (always-on, every push to `main`)

Staging is a **second Worker**, `nessebar-lens-staging`, at
`https://staging.nessebarlens.com`, with its own D1 (`nessebar-lens-orders-staging`).
It is distinct from a preview: staging is the Worker that *serves* traffic at
`staging.nessebarlens.com`, while a preview is a per-PR version **of the staging
Worker** that is never deployed (`upload`, not `deploy`). Both therefore share
staging's D1, and neither reaches production state — so a purchase can be
rehearsed end to end against sandbox Stripe and Prodigi. It is
declared as `[env.staging]` in `wrangler.toml` (bindings are not inherited by a
wrangler environment, so `ORDERS_DB`, `WEB` and `MASTERS` are redeclared there).
`WEB` is the production `nessebar-lens-web` (public derivatives only). `MASTERS`
is **not** shared: it is `nessebar-lens-masters-staging` (#212), see
§Masters bucket per environment below.

`.github/workflows/release.yml` runs on push to `main` and `workflow_dispatch`, and
staging is its third job, after `checks` and the per-environment `build` matrix:
`wrangler d1 migrations apply … --env staging --remote` → secrets file via
`scripts/sync-worker-secrets.sh staging` → `opennextjs-cloudflare deploy
--env staging --secrets-file` → `scripts/smoke.sh https://staging.nessebarlens.com`.
The `staging` target of the script keeps the `sk_test_` check and, unlike
`preview`, **fails** rather than warns when `RESEND_API_KEY`,
`PRODIGI_WEBHOOK_TOKEN` or `PRINT_ASSET_HMAC_SECRET` is missing. Deploys queue and
are never cancelled, so a run cannot stop between migration and deploy.

Staging is now a **gate**, not a rehearsal: production is `needs: staging`, so a
green migrate + deploy + smoke on staging is a precondition for the production
deploy. Before #200 both workflows triggered on the same push and ran in
parallel, which meant a staging smoke failure shipped to production anyway.

The staging job verifies the artifact it downloaded before deploying it —
`scripts/artifact-manifest.sh check` proves the tree survived the artifact
round-trip unchanged, and `scripts/assert-artifact-origin.sh` proves it was built
with staging's origin and carries no trace of production's. The two-build matrix
is what makes that check necessary (see §6).

Manual equivalent (break-glass; needs the staging secrets in your shell):

```bash
SITE_URL=https://staging.nessebarlens.com npx opennextjs-cloudflare build
npx wrangler d1 migrations apply nessebar-lens-orders-staging --remote --env staging
SYNC_SCOPE=version-only SECRETS_OUT=staging-secrets.json \
  bash scripts/sync-worker-secrets.sh staging
npx opennextjs-cloudflare deploy --env staging --secrets-file=staging-secrets.json
rm -f staging-secrets.json
```

`--env staging` must be on **every** wrangler call that touches staging: without
it wrangler resolves the top-level config, which is production (`nessebar-lens`
and `nessebar-lens-orders`). That includes `d1 execute` and `d1 migrations`.

New migration? Nothing extra: the workflow applies it to staging before the
deploy, which is also the rehearsal for applying it to production by hand.

#### Manual end-to-end purchase on staging

Use this before cutting a release that touches checkout, fulfillment, email or
the webhooks.

1. **Buy.** Open `https://staging.nessebarlens.com`, pick a physical print, and
   check out with Stripe test card `4242 4242 4242 4242`, any future expiry, any
   CVC, any postcode, and a real-looking shipping address. Note the
   `cs_test_…` session id in the success-page URL.
2. **Stripe webhook.** In the Stripe **test-mode** dashboard, Developers →
   Webhooks → the staging endpoint (`https://staging.nessebarlens.com/api/webhooks/stripe`,
   events `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `charge.refunded`, `charge.dispute.created`). The delivery for your session
   must show `200`. A `400` is a signing-secret mismatch (`STRIPE_WEBHOOK_SECRET`
   in the `staging` Environment is that endpoint's `whsec_…`); a `503` means a
   binding is missing. Resend from the dashboard after fixing.
3. **Order in D1.**
   ```bash
   npx wrangler d1 execute nessebar-lens-orders-staging --remote --env staging \
     --command "select session_id, status, terminal, reason, attempts, updated_at from orders order by created_at desc limit 5"
   ```
   Expect `status = 'fulfilled'` (or `paid-unfulfilled` with a `reason` naming
   what failed). The full record, including the Prodigi order id, is the `record`
   JSON column.
4. **Prodigi sandbox order.** Find the order id from step 3 in the Prodigi
   sandbox dashboard (`dashboard.prodigi.com`, sandbox toggle). The order's
   asset URL must be a signed `/api/print-asset?…` on `staging.nessebarlens.com`,
   never the placeholder.
5. **Prodigi callbacks.** The order was created with
   `callbackUrl=https://staging.nessebarlens.com/api/webhooks/prodigi?token=…`,
   built from `PRODIGI_WEBHOOK_TOKEN`. Advance the sandbox order's stage from the
   dashboard and confirm `select count(*) from prodigi_callbacks` grows and the
   order's status follows. To probe the route by hand:
   `curl -i -X POST 'https://staging.nessebarlens.com/api/webhooks/prodigi?token=wrong'`
   must answer `401`; `503 prodigi-webhook-unconfigured` means the token binding
   is missing from the deployed version. Never paste the real token into an
   issue or a log.
6. **Email.** The buyer address receives the order confirmation through Resend.
   Check the Resend dashboard → Emails for the send and its delivery state. With
   an unverified sending domain Resend only delivers to the account owner's own
   address, so use that as the buyer email.

If step 3 shows no row at all, the webhook never arrived or hit the wrong
Worker: check step 2 first, then `npx wrangler tail nessebar-lens-staging`.

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

Before any of that, the `production` job runs **`Verify production masters`**
(`npm run verify:masters`, #243) after the downloaded build is verified and
before the D1 migrations. It `HeadObject`s
`nessebar-lens-masters/prints/{slug}.jpg` for every published photo and compares
the object's `sha256` metadata against the catalog's `master_sha256`; a photo
whose master is missing, empty, or stale fails the release with production still
on its current version, so a forgotten `--promote` stops the deploy instead of
shipping a photo that cannot be downloaded or printed. The fix is
`npm run publish-photos -- --promote --pr <n>` (§6a). While the placeholder
catalog is live the check skips the transitional slugs through an explicit
allow-list in `scripts/verify-masters.mjs` that #245 deletes. When every
published photo is still allow-listed the step is a no-op and does **not** need
the read-only token — it requires `R2_MASTERS_READ_*` only once the first real
photo is published, which is the first time it has anything to read.

Production targets the **production Worker**, `nessebar-lens` — the top-level
bindings in `wrangler.toml`. A preview targets the **staging Worker**,
`nessebar-lens-staging`, as a version of it (#202); before that it was a version
of production and carried production's data bindings. Apex
`nessebarlens.com` / `www` CNAME to the production Worker (see the cutover
checklist below).

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
- `main = "worker.ts"`, **not** `.open-next/worker.js`. OpenNext's generated
  entry exports only `default { fetch }` plus the DO classes, so a cron trigger
  declared against it validates and then never fires. `worker.ts` re-exports the
  DO classes, delegates `fetch`, and adds `scheduled()`.
- `[triggers] crons` and `[env.staging.triggers] crons` are both declared, and
  both are required: wrangler does not inherit top-level keys into `[env.*]`,
  so a staging deploy without its own block is green and never reconciles.
  `NEXT_PUBLIC_SITE_URL` is set as a **var** in each env for the same reason --
  `worker.ts`'s `scheduled()` needs the origin at runtime and the build-time
  inlined constant is not readable from the Worker env.
- `preview_id` on a KV binding is a **KV namespace** preview id (`wrangler dev`),
  not a Pages preview-deployment concept. `scripts/remove-orders-kv.mjs` read and
  deleted both ids from the (now removed) `ORDERS` block.
- Runtime secrets (Stripe/Prodigi/RECONCILE_SECRET/PRODIGI_WEBHOOK_TOKEN/RESEND_API_KEY)
  live as **Worker secrets**, scoped per version.
  Sync with `scripts/sync-worker-secrets.sh`; rotate with `wrangler secret put`.
  `NEXT_PUBLIC_*` bake at build from GitHub Environment secrets and are
  deliberately not in the secret map — a `NEXT_PUBLIC_*` entry there would be a
  value that looks live and never changes.
  Resend also needs a **DNS TXT** record on the sending domain (see Resend → Domains);
  the API key alone is not enough for production delivery.

### D1 orders database

Production is already created and applied; staging is created and migrated too
(id in `wrangler.toml` under `[env.staging]`; `release.yml` keeps both migrated).
These are only for a fresh account:

```bash
npx wrangler d1 create nessebar-lens-orders
# paste the id into wrangler.toml [[d1_databases]].database_id
npx wrangler d1 migrations apply nessebar-lens-orders --local
```

Staging takes the same migrations with `--remote --env staging` and the staging
database name (`nessebar-lens-orders-staging`).

**There is no remote migration to run by hand.** `release.yml` applies
`wrangler d1 migrations apply … --remote` in both the staging and production jobs,
*before* the deploy in each — so a PR that adds a migration cannot ship code that
expects a schema the database does not have. (Before #200, production migrations
were a line in this document telling a human to remember, which is how code
reached production against a schema it did not match.) Local
(`--local`) remains a manual step; that is for reading your own change before you
push it.

Migrations are additive and idempotent — wrangler records each applied file in
`d1_migrations` — so a re-run after a rollback, or a manual
`--remote --local` replay, is a no-op.

#### Expand/contract — why there is no down-migration

**D1 has no down-migration, and Cloudflare does not offer one.** `release.yml`
rolls back the *Worker version* when the production smoke fails; it cannot roll
back the schema. A migration therefore lands *while the previous code is still
serving*, in two deployments, and it has to be safe for both.

Write every migration as expand/contract:

1. **Expand.** Add the new thing alongside the old one — a new column, a new
   table, a new index. Nothing reads it yet, so the old code is unaffected.
2. Ship code that *writes* both and reads the old one.
3. Ship code that reads the new one.
4. **Contract.** Only once no deployed version reads the old one, remove it — in a
   later PR, not the same one that added it.

Never rename or drop in the same migration that introduces the replacement, and
never make a column `NOT NULL` without a default in an expand step.

`tests/migrations-expand-contract.test.mts` enforces the mechanical part of this:
no `DROP` and no `RENAME` in `migrations/*.sql`, overridable per line with a
`-- contract:` marker so step 4 above is still expressible.

`migrations/0002_prodigi_callbacks.sql` adds the CloudEvent dedupe table for
`#117`.

**The initial migration has run.** On 2026-10-03, against main `e6227b2`:

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

### Masters bucket per environment (#212)

| Environment | `MASTERS` bucket | Contents |
|---|---|---|
| Production (top-level `wrangler.toml`) | `nessebar-lens-masters` | Full-resolution originals. Written only by `--promote` (#242). |
| Staging and every PR preview (`[env.staging]`) | `nessebar-lens-masters-staging` | Print-safe downscales **by design**: long edge <= 2500 px, JPEG quality 80, metadata stripped. Seeded by `publish-photos --apply` (#241). |

Why not share the production bucket: R2 bindings have no read-only mode (an
`R2Bucket` is read+write+delete, and `MastersBucket` being `get()`-only is a
TypeScript type, not an enforced control), a PR preview runs unreviewed code, and
masters are the product (the digital download is the master file). Staging only
needs the same photo at the same aspect ratio; Prodigi sandbox never prints.
`WEB` (public derivatives) stays shared. `tests/wrangler-bindings.test.mts`
fails if any `[env.*]` binds `nessebar-lens-masters` or `nessebar-lens-orders`.

**The staging bucket exists (created 2026-10-06).** Private, no custom domain,
r2.dev URL disabled. Only for a fresh account:

```
npx wrangler r2 bucket create nessebar-lens-masters-staging
```

Keep it private: do **not** enable public access or attach a custom domain. It
must exist **before** the config naming it is deployed, because a staging deploy
fails on a binding to a missing bucket. The Cloudflare API token behind
`release.yml` and `preview.yml` must be allowed to use R2 on this bucket; check
that first if a staging deploy fails on the binding.

**What it holds today.** Copies of the two placeholder masters that were already
in production, `prints/dawn.jpg` and `prints/cobblestones.jpg` (about 5.5 KB
each, so the copies are placeholders, not originals), so staging print orders and
digital downloads keep working. Every other slug is missing. There is no
placeholder fallback for masters: `src/lib/placeholder-photo.ts` only supplies the
gallery *display* image. `/api/print-asset` and `/api/download` read `MASTERS`
directly, and a missing object is a 404 `master-not-found` (a missing or throwing
binding is 503 `masters-unavailable`). So on staging, a print order's asset URL
or a digital download for an unseeded slug fails rather than serving a
placeholder, even though the page renders one.

`npm run publish-photos -- --apply` (§6a) writes the 2500 px staging copy, so a
newly published photo **is** purchasable on staging and its preview; only
`--promote` (#242) writes the production bucket's original. If a photo needs to
be seeded by hand before its publish run, use a downscale (long edge <= 2500 px,
quality 80, metadata stripped), never the original:

```
npx wrangler r2 object put nessebar-lens-masters-staging/prints/<slug>.jpg --remote --file <downscaled.jpg>
```


### Prodigi sandbox isolation (#193)

Prodigi's idempotency namespace is per **API key**, and staging, local dev and
production were all using the same sandbox key while sharing the Stripe test-mode
event stream. Two consequences, both live:

- The first deployment to POST an order for a session defines that order's asset
  URL and `callbackUrl` forever. Everyone else gets `{"outcome":"AlreadyExists",
  "order":{"id":"..."}}` and adopts it.
- The Stripe webhook in one environment receives deliveries created in another,
  because Stripe test mode has one event stream.

Code now handles `AlreadyExists` explicitly (`src/lib/prodigi-order.ts`): the
existing order is read back from `GET /v4.0/orders/{id}`, its own stage and asset
URL are recorded, and an order whose asset or callback is on a different origin
fails `prodigi-order-foreign` rather than claiming a URL Prodigi does not hold.
The idempotency key is namespaced `host:sessionId` off production — production
keeps the bare session id so existing orders are not re-keyed into a second
print.

The remaining fix is in the Stripe dashboard, not the repo:

1. **One Stripe webhook endpoint per environment.** Create a separate endpoint
   for `https://staging.nessebarlens.com/api/webhooks/stripe` and stop the
   production endpoint from receiving `checkout.session.completed` events whose
   session was created by staging. The session's `success_url` (and the
   `NEXT_PUBLIC_SITE_URL` of the creating deployment) identifies the origin.
2. **The handler and the reconciler reject foreign sessions.** Both compare the
   session's `success_url` origin with `siteUrl()` through `sessionOriginCheck`
   (parsed origins, so look-alike hosts are foreign; `www.` and the apex count
   as one site; an unreadable `success_url` is accepted). A foreign session is
   answered 200 (reconciler: counted in `foreign`) with no store write and no
   Prodigi call.
3. **After both**, delete the adopted sandbox order
   (`POST /v4.0/orders/ord_1177041/actions/cancel`) and re-run the staging
   purchase; `GET /v4.0/orders/<id>` must then show a `callbackUrl` on the
   staging origin.

Until (1) lands, every staging purchase races production for the same Prodigi
order, and the operator alert (`order-ops-alert`, #195) is what tells you it
happened.

---

### Reconciler

`POST /api/internal/reconcile`, guarded by `x-reconcile-secret` /
`RECONCILE_SECRET`. Triggered every 15 minutes by a **Cloudflare Cron Trigger**
(`[triggers] crons` in `wrangler.toml` → `worker.ts`'s `scheduled()`, which
builds the POST and calls the Worker's own `fetch` in-process — same path, same
header, one auth check), and on demand via `reconcile.yml`'s
`workflow_dispatch` (force a run after rotating a Prodigi key). It retries
paid-unfulfilled non-terminal orders through the same `fulfillCheckoutSession`
the webhook uses, recovers paid Stripe sessions with no stored order, and logs
`order.stuck` for #100.

GitHub's `schedule:` cannot carry this job: GitHub scheduled workflows are
best-effort and auto-disable after 60 days of repository inactivity, and
`reconcile.yml` asking for `*/15` actually delivered about 11 runs in 42 hours
(#201) — the real bound on recovery from a lost webhook was hours. A Cron
Trigger is delivered by the platform running the code, so the bound cannot be
dropped that way.

Two consequences worth knowing before you change anything here:

- **`RECONCILE_SECRET` is required for staging, not only production.** The cron
  runs in both envs, and the route answers 503 without the secret — a warning
  would deploy a reconciler that fails every tick.
- **A tick needs an origin.** `scheduled()` has no request to take a host from,
  so it reads `NEXT_PUBLIC_SITE_URL` from the Worker env and falls back to a
  deliberately fake `.invalid` host. The request never leaves the process.

---

## 6. CI/CD

GitHub Actions on `harveysmurf/nessebarlens` (Node 24.21.0, see §3):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `.github/workflows/ci.yml` | PR + `workflow_call` (from `release.yml`; no push trigger) | `npm ci` → lint → typecheck → test → **coverage floors**; plus a `workflow-audit` job (**install zizmor** → **gate on workflow script injection**, scoped to `template-injection` at Medium confidence and up — the other 40 findings are reported, not gated); plus two pull-request-only browser jobs — **required** `e2e-smoke` (no secrets: `npm ci` → **install chromium** → **e2e smoke flow (seeded)**: `npm run test:e2e -- --grep-invert @hosted` → **upload the failure trace** on failure) and **best-effort** `e2e-hosted-checkout` (`continue-on-error`; staging Environment → **install chromium** → **require a stripe test key** → **require a prodigi sandbox key** → **e2e hosted checkout** (`npm run test:e2e -- --grep @hosted`, headed under Xvfb) → **upload the trace** every run); plus `e2e-worker` — runs on PRs **and** `workflow_call` (release.yml builds the same tree), no secrets so it also runs on forks: **cache build** → **install chromium** → **prepare the local worker** (`.dev.vars` from non-secret values, `wrangler d1 migrations apply --local`, seed `MASTERS` with `e2e/fixtures/worker-master.jpg`) → **build catalog** (`npm run build:catalog`) → **build the worker** (`opennextjs-cloudflare build`, `NEXT_PUBLIC_SITE_URL=http://localhost:8787`) → **start the worker** (`opennextjs-cloudflare preview`) → **run e2e against the worker** (`npm run test:e2e -- --grep-invert @hosted` with `E2E_BASE_URL`, plus `e2e/worker-runtime.spec.ts`: print-asset streams the seeded master, Stripe webhook bad sig is 400 not 503, Prodigi webhook 401/400) → **smoke test the worker** (`scripts/smoke.sh`) → **upload the failure trace** |
| `.github/workflows/preview.yml` | PR open/sync | staging Environment → build → **Worker Version upload `--env staging`** (a version of `nessebar-lens-staging`, so `ORDERS_DB` is the staging D1 and unreviewed PR code cannot write production orders — #202; the step asserts the reported URL is a `…-nessebar-lens-staging.…` hostname) with secrets attached via `--secrets-file` → **smoke test** the version URL (`scripts/smoke.sh`) → PR comment; `versions list`/`delete --env staging` on close |
| `.github/workflows/release.yml` | push to `main` + `workflow_dispatch` | The whole production path, in order (`concurrency: release`, never cancelled). `checks` (`ci.yml`) → `build` (matrix over `staging`/`production`, one artifact each — `NEXT_PUBLIC_*` and `metadataBase` bake the origin into the prerendered HTML, so one shared artifact would put nessebarlens.com's canonicals on staging; each leg gets `environment: ${{ matrix.env }}` and its own `NEXT_PUBLIC_*`) → `staging`: staging Environment → verify artifact (`artifact-manifest.sh` + `assert-artifact-origin.sh`) → **D1 migrations (`--env staging`)** → `opennextjs-cloudflare deploy --env staging --secrets-file` (the `staging` target of `sync-worker-secrets.sh`: `sk_test_` enforced, Resend key / Prodigi token / print HMAC required) → **smoke test** `https://staging.nessebarlens.com` → `production` (`needs: staging`): production Environment → verify artifact → record the current `100%` version id → **D1 migrations (`--remote`)** → `opennextjs-cloudflare deploy --secrets-file` (guards run first in `version-only` mode) → **smoke test** `https://nessebarlens.com` → on failure `wrangler versions deploy <previous>@100 -y` and fail the job. `notify`/`resolve` from #199 on `main` |
| `.github/workflows/reconcile.yml` | `workflow_dispatch` only | production Environment → `POST /api/internal/reconcile` with `x-reconcile-secret`. The `*/15` schedule moved to a Cloudflare Cron Trigger (#201) because GitHub delivered about 11 of 168 expected runs in 42 h. Kept as the one-shot path and as the fallback for one release — **delete it once the Cron Trigger has a green week's worth of ticks in the dashboard** |
| `.github/workflows/verify-stripe.yml` | cron `37 6 * * 1-5` | staging Environment → guard that the key is `sk_test_` → `scripts/verify-stripe-integration.mjs` (disputes/refunds against test mode) |
| `.github/workflows/dependabot-triage.yml` | `pull_request` from `dependabot[bot]` | No secrets (#225). Reads the group with `dependabot/fetch-metadata` → **labels** the PR `deps:<group>` → for money-path groups (`deploy`, `framework`, `payments`, ungrouped security updates) **posts the rehearsal checklist** once per PR → for `dev-tooling`/`actions` **patch and minor only**, `gh pr merge --auto --squash`. Token is `contents: write` + `pull-requests: write` on the job only. See "Dependency updates". |
| `.github/workflows/release-backstop.yml` | hourly cron + `workflow_dispatch` | If the tip of `main` is more than 10 minutes old and `release.yml` has no run for that SHA, dispatches `release.yml` (#225). Covers merges made with `GITHUB_TOKEN` (auto-merge), which do not fire push workflows. |
| `.github/workflows/notify-failure.yml` | `workflow_call` only | The incident signal (#199). Not run directly — every workflow below calls it. Opens (or comments on) one `incident`-labelled issue per failing workflow, and closes it on the next green run. |

### Failure alerting (#199)

A red run on `main` notifies nobody by itself, and that is how production failed
ten times in a day and the reconcile cron six times without anyone noticing.
Each of `release.yml`, `reconcile.yml`, `verify-stripe.yml` and
`release-backstop.yml` ends with two jobs:

```yaml
notify:   { needs: [<every job>], if: failure() && github.ref == 'refs/heads/main', uses: $/.github/workflows/notify-failure.yml }
resolve:  { needs: [<every job>], if: success() && github.ref == 'refs/heads/main', uses: $/.github/workflows/notify-failure.yml, with: { close: true } }
```

Both are needed. `notify` alone leaves a wall of open incidents that nobody can
tell are live; `resolve` alone never opens one. `needs` lists *every* job in the
workflow, so a red `checks` job pages as loudly as a red deploy — that was the
flaky coverage floor that left production a commit behind while the merged PR
looked shipped.

The title is the identity. `notify-failure.yml` matches it **exactly** against
open `incident` issues (`jq` over `gh issue list --json number,title`, not a
`--search` substring — a substring match would stack all four workflows onto
whichever issue sorted first). So repeated failures accumulate as comments on one
issue, and the next green run comments and closes it. That is the whole reason
there is no new secret: GitHub's own issue notifications reach the owner by
email and mobile.

`issues: write` is declared on the notify *job*, never at a caller's workflow
level, so the workflows holding Cloudflare deploy credentials cannot write to
the tracker. `tests/workflow-hardening.test.mts` fails if a workflow that deploys
or runs on a schedule loses its notify/resolve pair, or if any other workflow
gains `issues: write` at the top level. `preview.yml` is exempt: it runs on
`pull_request`, where the PR is the notification, and its deploy target is a
version URL that only the PR author is waiting on.

Adding a new deploy or scheduled workflow means adding the two jobs. The test
tells you.

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

### Required status checks (#205 item 1)

`main` requires exactly the contexts listed in `.github/required-checks.txt` —
`Lint & test`, `Workflow audit`, `E2E smoke flow`, `E2E Worker runtime`.
Before #205, protection required only `Lint & test`, so the zizmor gate and the
browser smoke flow could both be red and the merge button was still enabled.

A branch-protection rule is a repository setting, so nothing in the repo can
force it to stay correct. Two things do, and the split between them is a hard
platform limit rather than a preference:

- `tests/branch-protection.test.mts` holds the committed list against `ci.yml`
  in both directions — a new gating job missing from the list fails, a list
  entry matching no job name fails, and a `continue-on-error` job listed as
  required fails. This runs on **every test run**.
- `scripts/required-checks.mjs` holds the committed list against the **live**
  rule and prints the exact `gh api` call to reconcile. It is run **by hand**,
  not from CI.

The live half cannot be a workflow step. Reading branch protection requires the
`administration` permission, which is not among the scopes `permissions:`
accepts for a job's `GITHUB_TOKEN` (`actionlint`: `unknown permission scope
"administration"`), and no other Actions-provided token carries it. Wiring the
step in anyway only produces a check that fails with `no GITHUB_TOKEN/GH_TOKEN`
on every run while reporting nothing about real drift — which is exactly what
happened while it was in `ci.yml`. The alternative, an admin-scoped PAT in
Actions secrets, would park a repo-admin credential exactly where the
job-scoped-permissions discipline in #209 keeps it out, which is a worse trade
than rare, deliberate UI drift.

Adding a gate to `ci.yml` therefore means three edits: the job, its line in
`.github/required-checks.txt`, and the `gh api -X PATCH` that makes GitHub agree.
Miss the second and the test fails on every run. Miss the third and only the
manual comparison finds it.

Run the live comparison locally with a token that can read protection:

```
GITHUB_TOKEN=$(gh auth token) node scripts/required-checks.mjs
```

`E2E hosted checkout (best effort)` stays optional. It is `continue-on-error`
(#169), so requiring it would block merges on a result the workflow itself
discards.

### Action versions and the runner image

Two pins that are not about application code, and both of which move under you
if nobody watches them.

**Actions are on Node 24 majors** (`checkout` v5, `setup-node` v5,
`upload-artifact` v6, `download-artifact` v7, `github-script` v8), each
SHA-pinned with its `# vX.Y.Z` comment. The previous pins all ran on Node 20,
which GitHub now force-upgrades at run time with a deprecation annotation on
every single run — noise that trains people to ignore annotations. Note the
artifact majors are not 5: `upload-artifact` v5 and `download-artifact` v5/v6
were released as Node 24 *preparations* and still declared `using: node20`; v6
and v7 are the first that actually run on it.

**Every job runs on `ubuntu-24.04`, never `ubuntu-latest`** (`#205`). The
`ubuntu-latest` label migrates to Ubuntu 26 on 2026-10-19, and a runner image is
not just a kernel bump — it moves OpenSSL, glibc, and the package list
`playwright install --with-deps` installs. That change would land inside a
production deploy, on a day nobody is reading CI.
`tests/workflow-hardening.test.mts` fails on any `ubuntu-latest` and requires
every `runs-on` to be exactly `ubuntu-24.04`. Moving to `26.04` is not forbidden
— do it in its own PR, after the e2e jobs are green on it.

### Dependency updates (#205, #225)

`.github/dependabot.yml` opens weekly PRs for both ecosystems. A SHA pin never
moves on its own, so "we pin" only does work once something is watching the
tags.

- **`github-actions`**, one group, one PR. The Node-runtime bumps and the
  artifact pair that moves with them only make sense together; one PR per action
  would open five and get them merged in the wrong order. Dependabot rewrites the
  SHA and keeps the `# vX.Y.Z` comment, so the pin format the hardening test
  enforces survives the bot — `tests/dependabot-config.test.mts` and the pin test
  in `tests/workflow-hardening.test.mts` hold that claim against fixtures.
- **`npm`**, grouped by what has to move together: `framework`
  (`next` + `react` + `react-dom`), `deploy` (`wrangler` +
  `@opennextjs/cloudflare` — opennext gates on the wrangler it is built against,
  so a mismatch fails inside opennext rather than here), `payments` (`stripe`,
  alone because it is the only group allowed to move on its own), and
  `dev-tooling` as a `*` catch-all with the three named groups excluded.
  Without the exclusions the catch-all wins and the grouping silently stops
  happening.

Security updates are on by default in v2 and are not disabled anywhere. Do not
trade them for a tidier cadence.

**One exception, and it is a manual bump: `setup-node` in
`.github/actions/setup/action.yml`.** Dependabot's `github-actions` ecosystem
reads `.github/workflows/` and nothing else, so the composite action is outside
its directory. This was measured, not assumed: its first run (#217 updated
checkout, upload-artifact, download-artifact and github-script across all six
workflows and left that file untouched), and no config value changes it. It is
the one pin in this repo no bot maintains, so it is named in
`tests/dependabot-config.test.mts` — which fails if a second action ever lands
somewhere else Dependabot cannot see.

`tests/dependabot-config.test.mts` pins the shape, not just the existence:
deleting the file, splitting a group, or adding an `ignore` list all produce no
CI failure otherwise, because a missing bot produces no failures.

#### Validating a bump before merge (#225)

Dependabot runs get **no Actions or Environment secrets**, so `Preview` and
`E2E hosted checkout` skip themselves (#224). A green Dependabot PR is
therefore **not** a verified one: what ran is the secret-free half of CI, and
which groups that half covers is the table below.

| Group | Packages | Validated before merge by | Merge policy |
|---|---|---|---|
| `deploy` | `wrangler`, `@opennextjs/cloudflare` | `E2E Worker runtime` (**required**; secret-free OpenNext build + `wrangler dev` + Playwright + smoke, #204) + rehearsal | Human. Never auto-merged |
| `framework` | `next`, `react`, `react-dom` | `E2E Worker runtime` + rehearsal | Human. Never auto-merged |
| `payments` | `stripe` | `tests/stripe-contract.test.mts` + the compile-time contract in `src/lib/stripe-event.ts` + the pinned `STRIPE_API_VERSION` + rehearsal | Human. Never auto-merged |
| `actions` | GitHub Actions | workflow audit + `tests/workflow-hardening.test.mts` | Auto-merge, patch/minor |
| `dev-tooling` | everything else | lint, typecheck, test, coverage, E2E jobs | Auto-merge, patch/minor |
| ungrouped | security updates (Dependabot never groups them) | whatever ran | Held, checklist posted |

Majors never auto-merge, in any group. `dependabot-triage.yml` labels every
PR `deps:<group>` and decides from the `fetch-metadata` update type; an empty
or unreadable type matches no auto-merge arm, so it holds.

**Rehearsal, and "push, don't re-run".** Money-path PRs get a bot checklist:
push to the branch so CI runs again with secrets, then do one sandbox purchase
on the preview. A **re-run does not work**: it keeps Dependabot's restricted
context (`github.actor` stays `dependabot[bot]`) and the secret-holding jobs
skip again. Only a push by a human, an empty commit or a rebase, runs them.
Once a human has pushed, Dependabot stops rebasing that PR;
`@dependabot recreate` restores it, discarding the human commit. The triage
job also requires `github.actor == 'dependabot[bot]'`, so the rehearsal push
does not re-run auto-merge logic on a branch holding a human's commit.

**Post-merge backstop.** A Dependabot commit takes the same path as any other:
`release.yml` (staging, smoke, production gate), no special-casing. One
platform rule stands in the way: events caused by `GITHUB_TOKEN` do not start
workflow runs, except `workflow_dispatch`. Auto-merge enabled by the triage
job's token can therefore land on `main` without firing the push trigger, and
`main` would sit unreleased. `release-backstop.yml` polls hourly and
dispatches `release.yml` when the tip of `main` has no run for its SHA. It
waits 10 minutes before acting, so a slow push trigger does not get a second
release, and scheduled runs are delayed under load, so the effective lag is up
to an hour or more. It is not Dependabot-specific.

**Stripe fixtures.** `tests/fixtures/stripe/` holds **real sandbox
captures**, scrubbed of personal data. Refresh them with:

```sh
STRIPE_SECRET_KEY=sk_test_… node scripts/capture-stripe-fixtures.mjs
```

It needs events from the **last 30 days**: one sandbox physical purchase;
refunds and disputes come from `verify-stripe.yml`'s runs. Review the scrubbed
diff before committing. **Recapture whenever the webhook endpoint's (or account default) API version
changes** (the contract test's `WEBHOOK_API_VERSION` fails otherwise, by
design); it is also worth doing when the `stripe` SDK major moves.
`STRIPE_API_VERSION` only pins API requests, not payload shape.

**Adding a Dependabot group** means adding it to the `case` in
`dependabot-triage.yml`. `tests/dependabot-config.test.mts` fails if you do
not, and the workflow's `*)` arm fails the job at runtime.

### What each Environment holds

The expected secret set per environment, checked rather than remembered.
`tests/workflow-secrets.test.mts` asserts in both directions: every
`secrets.X` a workflow reads is listed here, and every name listed here still
has a reader. The second direction is the one that matters — a secret left in
GitHub after its last reader is gone is pure exposure, and from inside the
repository it looks identical to a live one until somebody opens the account
settings.

| Scope | Expected secrets |
|---|---|
| `staging` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED`, `NEXT_PUBLIC_WEB_IMAGES_BASE`, `PRINT_ASSET_HMAC_SECRET`, `PRODIGI_API_KEY`, `PRODIGI_SANDBOX_API_KEY`, `PRODIGI_WEBHOOK_TOKEN`, `RECONCILE_SECRET`, `RESEND_API_KEY`, `SITE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| `production` | the same fourteen, with live values, plus the read-only masters token: `R2_MASTERS_READ_ACCESS_KEY_ID`, `R2_MASTERS_READ_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT` (#243) |
| repository | `PRINT_ASSET_HMAC_SECRET` only |

`release.yml`'s build matrix declares `environment: ${{ matrix.env }}` and so
reads its `NEXT_PUBLIC_*` from both — the same name with a different value in
each, which is why this is a set per environment and not a flat list.

`PRINT_ASSET_HMAC_SECRET` is a *repository* secret because it signs print-asset
URLs and has to be the same value everywhere: a signature made with one key and
checked with another is the failure the indirection exists to avoid. The
hosted-checkout job is the one place both scopes are read side by side.

The three production `R2_*` rows are the release gate's read-only token (#243):
`R2_MASTERS_READ_ACCESS_KEY_ID` / `R2_MASTERS_READ_SECRET_ACCESS_KEY` are scoped
to Object Read on `nessebar-lens-masters` only, and `R2_S3_ENDPOINT` is where
they connect. They are in no other environment, and `release.yml` is push-only,
so a `pull_request` job never holds them. `scripts/verify-masters.mjs` is the
only reader.

Not in the table, and asserted to stay out (`#205` item 6): `CF_ACCOUNT_ID` and
`CF_API_TOKEN`, the pre-Workers names for the Cloudflare token, which
`scripts/sync-worker-secrets.sh` still accepts as a fallback but no workflow
passes; and `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`,
`R2_ACCOUNT_ID` — the **write-capable** S3-compatibility keys. The site reaches
R2 through the Workers *binding*, not the S3 API, so those were a second
long-lived credential for the same data with no code behind it. The R2 key has
to be revoked at Cloudflare as well as deleted from the Environment. (The
read-only token above is a deliberate exception, distinct from these.)

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
`release.yml` (`workflow_dispatch`). This rebuilds and redeploys — staging first,
production after it smokes green — carrying the secrets on the deploying version
via `--secrets-file`.

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

- **`staging`** — read by `preview.yml` and by `release.yml`'s build matrix leg and staging deploy job: sandbox Stripe + `PRODIGI_API_BASE=https://api.sandbox.prodigi.com` +
  `PRODIGI_SANDBOX_API_KEY` + `SITE_URL=https://staging.nessebarlens.com` +
  `PRODIGI_WEBHOOK_TOKEN` (shared with whatever injects the bearer on sandbox
  callbacks) + `RESEND_API_KEY` (Resend test/sandbox key is fine; domain
  verification still required before real inboxes accept mail).
  The `e2e-hosted-checkout` job also reads its keys from here, so it needs
  `environment: staging` — the repository has only `PRINT_ASSET_HMAC_SECRET`, and
  without the environment line every guard would resolve to nothing. Its one
  Stripe key is the `sk_test_` sandbox one, which the job's `sk_test_*` guard
  enforces before anything is spent. The required `e2e-smoke` job reads no
  secret at all, which is why it still runs on fork pull requests where GitHub
  withholds them.
- **`production`** — required reviewer `harveysmurf`. Live Stripe
  (`sk_live_*` + live webhook secret) + `PRODIGI_API_BASE=https://api.prodigi.com` +
  `PRODIGI_API_KEY` (live org key) + `PRODIGI_WEBHOOK_TOKEN` + `RESEND_API_KEY`
  (live Resend key; sending domain DNS TXT verified). Host is never inferred
  from which key is set. Preview/staging stays sandbox.

Secrets live in those Environments (never in git). Local `.env.local` remains the
Debian-host symlink to `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`.

---

## 6a. Publishing photos (drop folder → web ladder + staging master + catalog PR)

Simo runs this from his own box, not CI. Three prerequisites, in order:

1. **Node 24.21** — `nvm use` in the repo root. `npm run publish-photos` checks
   the pin in `.nvmrc` and stops with `publish-photos needs Node 24.21.0`
   otherwise, because `sharp` is a native binding and a mismatch otherwise
   surfaces as an opaque `ERR_UNKNOWN_FILE_EXTENSION`.
2. **`npm install`** — `sharp`, `@aws-sdk/client-s3` and `yaml` are
   devDependencies only this tool uses; the site itself never imports them.
3. **R2 credentials in `.env.local`** (gitignored, loaded with
   `process.loadEnvFile`) or exported:

   ```
   R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   ```

   From Cloudflare → R2 → Manage R2 API Tokens → *Object Read & Write* scoped
   to exactly `nessebar-lens-web` and `nessebar-lens-masters-staging` (and
   `nessebar-lens-masters` for `--promote`, #242). The workspace copy lives in
   `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`. Missing keys fail as
   `missing env: R2_ACCESS_KEY_ID ...`, never as a 403.

Then, per photo, drop a `<slug>.jpg` **and** a `<slug>.yaml` (the catalog entry
from §7) into `ingest/` (repo root, gitignored), both named for the same slug:

- `npm run publish-photos` — **dry run.** Validates the batch and prints the
  eight web objects, the staging master and the YAML path per photo. Nothing is
  uploaded.
- `npm run publish-photos -- --apply` — uploads the eight web objects per photo
  (four widths × JPEG/WebP) to
  `nessebar-lens-web/{slug}/{hash8}/{400,750,1500,2000}.{jpg,webp}`, uploads the
  **staging master** (long edge ≤ 2500 px, JPEG q80, sRGB, metadata stripped) to
  `nessebar-lens-masters-staging/prints/{slug}.jpg`, writes `slug`,
  `master_sha256` and `image_hash` into `content/photos/{slug}.yaml` preserving
  the owner's comments and key order, writes the committed fallback
  `public/placeholders/{slug}.jpg` (long edge ≤ 1600 px, metadata stripped — the
  tile checkout shows with the ladder off, #257), then opens **one PR** for the
  run. That PR is `content/photos/**` plus `public/placeholders/**` only.
- `--only dawn,dusk` narrows a run; `--replace-image dawn` re-publishes an
  existing slug (the new master's hash must differ).
- The production masters bucket is **never** written by `--apply`. Its client
  only has the web and staging buckets, so a `--promote` object is unreachable
  from this command.

### After the preview: `--promote` (#242)

Once the PR's preview has been checked, the second half runs from the same box,
with the same `ingest/` folder still in place:

```
npm run publish-photos -- --promote --pr <n>
```

It reads the PR's changed `content/photos/*.yaml` **from the PR head** (the PR,
not `ingest/` and not `main`, is the authority on what to promote) and refuses
unless the PR is open, targets `main`, was opened by the owner (`gh api user`),
and changes nothing outside `content/photos/` and `public/placeholders/` (the
catalog entry and the committed fallback a publish writes, #257). For each slug
it hashes the local
`ingest/{slug}.jpg` and refuses unless that SHA-256 is exactly the
`master_sha256` the YAML recorded, so the promoted bytes are the ones that were
previewed — **stop before any upload** if one file does not match.

For each master it writes the **unmodified** bytes to
`nessebar-lens-masters/prints/{slug}.jpg` with `Content-Type: image/jpeg`, user
metadata `sha256=<master_sha256>` (the header the release check reads, #243) and
`Cache-Control: private, no-store`. An object already holding the same hash is
skipped; a different hash is refused unless the PR **modified** an existing
catalog entry (a `--replace-image`), which overwrites the fixed key and reminds
you that past buyers' downloads now get the new file. It then `HeadObject`s each
key and confirms the `sha256` metadata and byte length before running
`gh pr merge <n> --auto --squash`. Merging deploys staging → smoke tests →
master check → production.

What to do if `--promote` refuses:

- **`ingest/x.jpg is not the file that was previewed`** — the local JPEG is not
  the one `--apply` hashed. Restore the exact file that was dropped, or re-run
  `--apply` to publish the current one and re-check the preview.
- **`missing ingest/x.jpg`** — the local master is gone; put the original back.
- **`already holds a different master … pass --replace-image`** — production
  already serves a different file for that slug. If the new bytes are intended,
  re-run `--apply --replace-image x` so the PR modifies the entry, then promote.
- **`changes files outside content/photos/ and public/placeholders/`** — the PR
  is broader than a photo publish; promote does not merge it. Split the photo
  change into its own PR.

Nothing is uploaded and auto-merge is not enabled on any refusal, so fixing the
input and re-running is always safe. The web keys from `--apply` are
content-addressed, so they are never rewritten by a promote.

Validation runs before any upload and reports every problem: the YAML must pass
the schema with `master_sha256`/`image_hash` absent; the long edge must be
≥ 3500 px (a warning below 6000 px); a new slug must not already exist; the
working tree must be clean apart from `ingest/` and `content/photos/`. Web keys
are content-addressed (`{slug}/{hash8}/…`), so re-running skips identical
objects, and the derivatives can be served
`Cache-Control: public, max-age=31536000, immutable`.

The rung list is `WEB_DERIVATIVE_WIDTHS` in `src/lib/derivative-ladder.ts` —
one array, read by the srcSet the site serves, the web upload plan and the
tests. Changing the rungs is a one-line edit there.

`npm run ingest` is the one-release deprecated alias for `npm run publish-photos`.

---

## 7. Data flow & invariants

- **The catalog is YAML, compiled at build time.** One file per photo lives in
  `content/photos/<slug>.yaml`; `scripts/build-catalog.mjs` validates every file
  against `src/lib/photo-schema.ts` and writes the git-ignored
  `src/generated/catalog.ts`. Workers have no filesystem, and `getPhoto()` is
  read at request time by the checkout route and fulfillment, so the YAML cannot
  be parsed at runtime — it is compiled ahead of it. Every path that builds,
  tests or lints runs `npm run build:catalog` first (the `pre*` hooks in
  `package.json`, and an explicit `Build catalog` step before
  `opennextjs-cloudflare build` in `ci.yml`, `release.yml`, `preview.yml`), so no
  path can build against a stale or missing catalog.
- **One definition of a photo file.** `src/lib/photo-schema.ts` is the schema:
  the field rules, the fixed categories and the film looks, exported as the
  `PhotoFile` type and the `validatePhotoFile` runtime validator. Unknown keys
  are an error, not ignored, so a typo like `catgory` fails the build loudly.
  `slug` defaults to the filename and must equal it; `film_look` is film-only;
  `hero_caption` is required when `featured` is true; at most one published
  photo may set `featured`; `published` defaults true. A photo with
  `published: false` is absent from the generated catalog, so every listing,
  `generateStaticParams` and `getPhoto` (and therefore checkout) leave it out.
- **`src/lib/photos.ts` is the runtime view.** It keeps its public API
  (`PHOTOS`, `getPhoto`, `photosByCategory`, `categoryHref`, `filmLookClass`,
  `featuredPhoto`, the `Photo` type), now backed by the generated file.
  `categoryLabel` is derived from the category (one `Record`) and `imageKey` is
  derived as `prints/{slug}.jpg` — the only form `masterKeyForSlug` accepts
  (`src/lib/master-key.ts`). The only master-key list is that derived
  `imageKey`, surfaced via `masterKeyForSlug()`.
- **The homepage hero is the featured photo.** `featuredPhoto()` returns the one
  photo with `featured: true`, or else the first published fine-art photo in
  display order, so `src/app/page.tsx` no longer hard-codes a slug.
- **Placeholders.** `public/placeholders/{slug}.jpg` are 20 local stand-ins
  (7 fine-art, 7 archive, 6 film). Gallery images resolve to
  `/placeholders/{slug}.jpg`; real photographs replace these on R2 later. Keep the
  slug set stable.
- **No remote image hosts.** `next.config.ts` sets `images.remotePatterns: []` —
  do not add `images.unsplash.com` or any third-party host. Gallery uses a plain
  `<picture>` (`src/components/WebPhoto.tsx`) — a WebP `<source>` plus a JPEG
  `<img>` srcset — against `NEXT_PUBLIC_WEB_IMAGES_BASE` only.
- **The derivative ladder is gated.** `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED`
  (default off) decides between the R2 ladder (`{slug}/{hash8}/{width}.{jpg|webp}`
  in `nessebar-lens-web`, four widths × two formats) and the committed
  placeholders. A photo with no `image_hash` also falls back to the placeholder.
  Set the base without the flag and the gallery keeps serving placeholders —
  that is deliberate, because the base is configured in every environment while
  both buckets are still empty. Turn the flag on only after the upload is
  verified, and expect `tests/placeholder-photo.test.mts` to need updating at
  that moment.
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
  1. Read the Prodigi config (`prodigiConfig()` → `readProdigiConfig`) **before**
     the request — never inside the `fetch()` argument list. The read returns a
     tagged result (`ok: false, kind: "unconfigured"`), so an unconfigured
     deployment is a distinct kind the caller maps to 503 rather than a throw it
     has to catch.
  2. Every "we are not configured" path produces a **distinct, retryable reason**
     and a **503**, so the record and the log say *what* is unset.

  `kind: "unconfigured"` on a failed `ProdigiResult` is the one signal for "our
  fault, not Prodigi's"; nothing matches the message text any more, so a new
  config error is classified by its kind rather than by whether its wording was
  remembered.

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
  the 20 placeholders. `npm run publish-photos` (§6a) uploads the web ladder and
  the staging master and opens the catalog PR; `--promote` (#242) writes the
  production masters after it merges.
- If a 502 shows up from `/api/quote` or `/api/checkout` and it is *not* Prodigi
  being down, the failure's `kind` is the answer: 503 means this deploy is
  misconfigured (`kind: "unconfigured"` — unset Prodigi key, or a
  `PRODIGI_API_BASE` outside the two allowed hosts); 502 means Prodigi
  (`kind: "timeout" | "client" | "server"`). The mapping lives in one function,
  `prodigiFailureFrom` in `src/lib/prodigi-config.ts`, and it reads only the
  `kind` — never the message text — so a new failure cannot slip into the wrong
  status. `tests/prodigi-config.test.mts` pins the kind→status mapping; that is
  the file to extend when the module gains a kind.
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
- The refund/dispute revocation path's two Stripe API shapes **are** verified
  against live test-mode Stripe as of #134 — the payment-intent lookup and the
  dispute→charge→payment-intent hop (§4, "Live Stripe API verification"). What
  remains unverified is that a real `charge.dispute.created` delivery reaches
  `/api/webhooks/stripe` with our signature secret on it: no test can deliver a
  signed webhook without the endpoint, which is the same gap the bullet above
  describes from the other end.
